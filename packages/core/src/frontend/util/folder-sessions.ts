import {
    type FolderSessions,
    PaneKind,
    type PaneSessionStatus,
    sessionCloseEndpoint,
    sessionCreateEndpoint,
    sessionListEndpoint,
    sessionRenameEndpoint,
    sessionSetAiEndpoint,
} from '@agent-storm/common';
import {extractErrorMessage, mapEnumToObject} from '@augment-vir/common';
import {type EndpointRequestType, HttpMethod} from '@rest-vir/api';
import {Observable} from 'element-vir';
import {fetchApi} from './api-client.js';

type SessionRequest<Params> = Readonly<Omit<Params, 'folder'>>;

export type FolderSessionsObservable = ReturnType<typeof createFolderSessions>;

/**
 * One pane group's session tabs, both kinds, loaded on creation. Each mutation replaces the list
 * with the server's answer so tab order and names match it, and resolves to that answer, or to
 * `undefined` after putting the failure in `error`. Lists only the sessions in `scope`, so a scoped
 * pane group and the folder's own don't show each other's terminals.
 */
export function createFolderSessions({
    folder,
    scope,
}: Readonly<{
    folder: string;
    scope?: string | undefined;
}>) {
    const observable = new Observable<{
        /**
         * Undefined until the first load resolves. The panes render nothing until then so a
         * terminal never mounts against a guessed session id.
         */
        sessions: FolderSessions | undefined;
        error: string | undefined;
        /** Live sessions the list was already reloaded for, so a missing one reloads it once. */
        reloadedSessionIds: ReadonlyArray<string>;
    }>({
        defaultValue: {
            sessions: undefined,
            error: undefined,
            reloadedSessionIds: [],
        },
    });

    /** Every pane group's sessions, so another group's live ones don't read as missing here. */
    const folderWide: {
        sessions: FolderSessions | undefined;
        /** Watch mode's tab, which every pane group of the folder lists whatever its scope. */
        watchSessionId: string;
    } = {
        sessions: undefined,
        watchSessionId: '',
    };

    function filterToScope(allSessions: Readonly<FolderSessions>) {
        return mapEnumToObject(PaneKind, (kind) => {
            return allSessions[kind].filter((session) => {
                return (
                    (session.scope || '') === (scope || '') ||
                    (!!folderWide.watchSessionId && session.id === folderWide.watchSessionId)
                );
            });
        });
    }

    function update(partial: Partial<typeof observable.value>) {
        observable.setValue({
            ...observable.value,
            ...partial,
        });
    }

    function reportError(error: unknown) {
        update({
            error: extractErrorMessage(error),
        });
    }

    async function applySessions(request: Promise<FolderSessions>) {
        try {
            const allSessions = await request;
            folderWide.sessions = allSessions;
            const sessions = filterToScope(allSessions);
            update({
                sessions,
                error: undefined,
            });
            return sessions;
        } catch (error) {
            reportError(error);
            return undefined;
        }
    }

    function reload() {
        return applySessions(
            fetchApi(sessionListEndpoint, HttpMethod.Post, {
                requestData: {
                    folder,
                },
            }),
        );
    }

    void reload();

    return Object.assign(observable, {
        reportError,
        /** Picks up changes the server made on its own, like the AI a restarted tab launched with. */
        reload,
        /** Reloads the list for a live session it's missing, and lists watch mode's current tab. */
        sync({
            sessionStatuses,
            watchSessionId,
        }: Readonly<{
            sessionStatuses: ReadonlyArray<Readonly<PaneSessionStatus>>;
            watchSessionId: string;
        }>) {
            const sessions = folderWide.sessions;
            if (watchSessionId !== folderWide.watchSessionId) {
                folderWide.watchSessionId = watchSessionId;
                if (sessions) {
                    update({
                        sessions: filterToScope(sessions),
                    });
                }
            }
            const {reloadedSessionIds} = observable.value;
            /**
             * A tab the server opened on its own, like watch mode's, appears as a live session
             * first.
             */
            const unlistedSessionId = sessions
                ? sessionStatuses.find((sessionStatus) => {
                      return (
                          !sessions[sessionStatus.kind].some(
                              (session) => session.id === sessionStatus.sessionId,
                          ) && !reloadedSessionIds.includes(sessionStatus.sessionId)
                      );
                  })?.sessionId
                : undefined;
            if (!unlistedSessionId) {
                return;
            }
            update({
                reloadedSessionIds: [
                    ...reloadedSessionIds,
                    unlistedSessionId,
                ],
            });
            void reload();
        },
        create(kind: PaneKind) {
            return applySessions(
                fetchApi(sessionCreateEndpoint, HttpMethod.Post, {
                    requestData: {
                        folder,
                        kind,
                        scope,
                    },
                }),
            );
        },
        rename(
            params: SessionRequest<
                EndpointRequestType<typeof sessionRenameEndpoint, typeof HttpMethod.Post>
            >,
        ) {
            return applySessions(
                fetchApi(sessionRenameEndpoint, HttpMethod.Post, {
                    requestData: {
                        ...params,
                        folder,
                    },
                }),
            );
        },
        close(
            params: SessionRequest<
                EndpointRequestType<typeof sessionCloseEndpoint, typeof HttpMethod.Post>
            >,
        ) {
            return applySessions(
                fetchApi(sessionCloseEndpoint, HttpMethod.Post, {
                    requestData: {
                        ...params,
                        folder,
                    },
                }),
            );
        },
        setAi(
            params: SessionRequest<
                EndpointRequestType<typeof sessionSetAiEndpoint, typeof HttpMethod.Post>
            >,
        ) {
            return applySessions(
                fetchApi(sessionSetAiEndpoint, HttpMethod.Post, {
                    requestData: {
                        ...params,
                        folder,
                    },
                }),
            );
        },
    });
}
