import {type AppServices} from '@agent-storm/core/frontend';
import {extractErrorMessage} from '@augment-vir/common';
import {Observable} from 'element-vir';
import {type BotsState} from '../bots-api.js';
import {addBotThreadTab} from './bot-tabs.js';
import {botsClient} from './bots-client.js';

/** The Bots plugin's server state, as this window last read it. */
export type BotsSnapshot = Readonly<{
    /** Undefined until the first read answers. */
    state: Readonly<BotsState> | undefined;
    loadError: string | undefined;
}>;

/** Everything the Bots activity keeps for the window's whole life. */
export function createBotsState() {
    return {
        snapshot: new Observable<BotsSnapshot>({
            defaultValue: {
                state: undefined,
                loadError: undefined,
            },
        }),
    };
}

export type BotsActivityState = ReturnType<typeof createBotsState>;

async function loadSnapshot(snapshot: BotsActivityState['snapshot']) {
    try {
        snapshot.setValue({
            state: await botsClient.call('readState', {}),
            loadError: undefined,
        });
    } catch (error) {
        snapshot.setValue({
            ...snapshot.value,
            loadError: extractErrorMessage(error),
        });
    }
}

/**
 * Keeps the snapshot current, and gives each AI run a bot starts an AI Chat tab in the bot's pane
 * group. Returns its remover.
 */
export function startBotsState({
    state,
    services,
}: Readonly<{
    state: BotsActivityState;
    services: Pick<AppServices, 'uiLayout'>;
}>) {
    /**
     * The AI runs that have had a tab, so a tab the user closes stays closed. Starts with the runs
     * from before the window opened, which the run history still opens.
     */
    const tabs = {
        threadIds: new Set<string>(),
        isSeeded: false,
    };

    function addRunTabs() {
        const repos = state.snapshot.value.state?.repos;
        if (!repos) {
            return;
        }
        const runThreads = repos.flatMap((repo) => {
            return repo.bots.flatMap((bot) => {
                return (bot.lastRun?.aiThreadIds || []).map((threadId) => {
                    return {
                        repoPath: repo.repoPath,
                        botId: bot.botId,
                        threadId,
                    };
                });
            });
        });
        if (!tabs.isSeeded) {
            tabs.isSeeded = true;
            runThreads.forEach(({threadId}) => tabs.threadIds.add(threadId));
            return;
        }
        runThreads
            .filter(({threadId}) => !tabs.threadIds.has(threadId))
            .forEach((runThread) => {
                if (
                    addBotThreadTab({
                        ...runThread,
                        uiLayout: services.uiLayout,
                        isShown: false,
                    })
                ) {
                    tabs.threadIds.add(runThread.threadId);
                }
            });
    }

    const removers = [
        botsClient.listen('stateChanged', async () => {
            await loadSnapshot(state.snapshot);
        }),
        botsClient.listenToReconnect(async () => {
            await loadSnapshot(state.snapshot);
        }),
        state.snapshot.listen(false, addRunTabs),
    ];
    void loadSnapshot(state.snapshot);

    return () => {
        removers.forEach((remove) => {
            remove();
        });
    };
}
