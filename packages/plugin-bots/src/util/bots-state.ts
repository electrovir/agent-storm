import {type AppContext, type AppServices} from '@agent-storm/core/frontend';
import {assertWrap} from '@augment-vir/assert';
import {extractErrorMessage} from '@augment-vir/common';
import {Observable} from 'element-vir';
import {
    BotConfigApproval,
    botsPluginId,
    toBotScope,
    toBotsConfigScope,
    type BotInfo,
    type BotRepo,
    type BotsState,
} from '../bots-api.js';
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

/** The Bots activity's state, which the activity creates for the window's whole life. */
export function findBotsState({activityStates}: Readonly<Pick<AppContext, 'activityStates'>>) {
    return assertWrap.isDefined(
        activityStates[botsPluginId],
    ) satisfies unknown as BotsActivityState;
}

/** What one bots pane group shows: a bot, or a repo's config before it has a bot to show. */
export type BotsTarget = Readonly<{
    repo: Readonly<BotRepo>;
    bot: Readonly<BotInfo> | undefined;
    scope: string;
}>;

function toBotTarget(repo: Readonly<BotRepo>, bot: Readonly<BotInfo>): BotsTarget {
    return {
        repo,
        bot,
        scope: toBotScope(bot.botId),
    };
}

/**
 * The target of the Bots activity's route segment, a bot id or a repo id. An approved repo opens on
 * its first bot, so approving a config moves its view onto the repo's bots.
 */
export function findSelectedBotsTarget({
    repos,
    selectedId,
}: Readonly<{
    repos: ReadonlyArray<Readonly<BotRepo>>;
    selectedId: string | undefined;
}>) {
    const botTarget = repos
        .flatMap((repo) => repo.bots.map((bot) => toBotTarget(repo, bot)))
        .find((target) => target.bot?.botId === selectedId);
    const repo = repos.find((candidate) => candidate.repoId === selectedId);
    const firstBot =
        repo?.approval === BotConfigApproval.Approved && !repo.listError ? repo.bots[0] : undefined;
    if (botTarget || !repo) {
        return botTarget;
    } else if (firstBot) {
        return toBotTarget(repo, firstBot);
    } else {
        return {
            repo,
            bot: undefined,
            scope: toBotsConfigScope(repo.repoId),
        } satisfies BotsTarget;
    }
}

/** The target whose pane group has `scope`. */
export function findBotsTargetByScope({
    repos,
    scope,
}: Readonly<{
    repos: ReadonlyArray<Readonly<BotRepo>>;
    scope: string | undefined;
}>) {
    return repos
        .flatMap((repo): ReadonlyArray<BotsTarget> => {
            return [
                {
                    repo,
                    bot: undefined,
                    scope: toBotsConfigScope(repo.repoId),
                },
                ...repo.bots.map((bot) => toBotTarget(repo, bot)),
            ];
        })
        .find((target) => target.scope === scope);
}

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
 * Keeps the snapshot current, and gives each bot's AI thread an AI Chat tab in the bot's pane
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
     * Each bot's thread that last had a tab, by bot id, so a tab the user closes stays closed until
     * the bot moves to another thread. Starts with the threads from before the window opened, which
     * the bot's view still opens.
     */
    const tabs = {
        threadIds: new Map<string, string>(),
        isSeeded: false,
    };

    function addBotTabs() {
        const repos = state.snapshot.value.state?.repos;
        if (!repos) {
            return;
        }
        const botThreads = repos.flatMap((repo) => {
            return repo.bots.flatMap((bot) => {
                return bot.aiThreadId
                    ? [
                          {
                              repoPath: repo.repoPath,
                              botId: bot.botId,
                              threadId: bot.aiThreadId,
                          },
                      ]
                    : [];
            });
        });
        if (!tabs.isSeeded) {
            tabs.isSeeded = true;
            botThreads.forEach(({botId, threadId}) => tabs.threadIds.set(botId, threadId));
            return;
        }
        botThreads
            .filter(({botId, threadId}) => tabs.threadIds.get(botId) !== threadId)
            .forEach((botThread) => {
                if (
                    addBotThreadTab({
                        ...botThread,
                        uiLayout: services.uiLayout,
                        isShown: false,
                        replacedThreadId: tabs.threadIds.get(botThread.botId),
                    })
                ) {
                    tabs.threadIds.set(botThread.botId, botThread.threadId);
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
        state.snapshot.listen(false, addBotTabs),
    ];
    void loadSnapshot(state.snapshot);

    return () => {
        removers.forEach((remove) => {
            remove();
        });
    };
}
