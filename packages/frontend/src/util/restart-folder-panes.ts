import {PaneKind, restartPaneEndpoint, sessionListEndpoint} from '@agent-storm/common';
import {awaitedForEach, getObjectTypedValues} from '@augment-vir/common';
import {HttpMethod} from '@rest-vir/api';
import {fetchApi} from './api-client.js';

export type PaneRestartedEvent = {
    folder: string;
    kind: PaneKind;
};

/**
 * Respawn every session of both kinds under one folder, then remount their terminals. Unlike "Kill
 * panes" the tab list survives — this is the recovery path for panes whose processes are gone (a
 * daemon that ran out of PTYs, an agent that crashed) rather than a teardown.
 */
export async function restartFolderPanes({
    folder,
    emitPaneRestarted,
    onError,
}: Readonly<{
    folder: string;
    emitPaneRestarted: (detail: PaneRestartedEvent) => void;
    onError: (error: unknown) => void;
}>): Promise<void> {
    try {
        const sessions = await fetchApi(sessionListEndpoint, HttpMethod.Post, {
            requestData: {
                folder,
            },
        });
        await awaitedForEach(getObjectTypedValues(PaneKind), async (kind) => {
            /**
             * Serial rather than parallel: each restart spawns a shell that sources the user's
             * profile, and a folder with several tabs per kind would otherwise fire all of them at
             * once.
             */
            await awaitedForEach(sessions[kind], async (session) => {
                await fetchApi(restartPaneEndpoint, HttpMethod.Post, {
                    requestData: {
                        folder,
                        kind,
                        sessionId: session.id,
                    },
                });
            });
            emitPaneRestarted({
                folder,
                kind,
            });
        });
    } catch (error: unknown) {
        onError(error);
    }
}
