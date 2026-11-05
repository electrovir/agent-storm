import {
    type FolderSessions,
    type PaneKind,
    type PaneSessionStatus,
    sessionCloseEndpoint,
    sessionCreateEndpoint,
    sessionListEndpoint,
    type SessionMeta,
    sessionRenameEndpoint,
    sessionSetAiEndpoint,
} from '@agent-storm/common';
import {extractErrorMessage} from '@augment-vir/common';
import {type EndpointRequestType, HttpMethod} from '@rest-vir/api';
import {Observable} from 'element-vir';
import {fetchApi} from './api-client.js';

/**
 * Resolve a 1-based URL index to a live session. An index can outlive the session it referenced
 * (the tab was closed, or the folder's list shrank), so anything out of range falls back to the
 * first session rather than rendering an empty pane.
 */
export function sessionAtIndex(
    sessions: ReadonlyArray<Readonly<SessionMeta>>,
    oneBasedIndex: number,
): Readonly<SessionMeta> | undefined {
    return sessions[oneBasedIndex - 1] || sessions[0];
}

type SessionRequest<Params> = Readonly<Omit<Params, 'folder'>>;

export type FolderSessionsObservable = ReturnType<typeof createFolderSessions>;

/**
 * One folder's session tabs, both kinds, loaded on creation. Each mutation replaces the list with
 * the server's answer so tab order and names match it, and resolves to that answer, or to
 * `undefined` after putting the failure in `error`.
 */
export function createFolderSessions(folder: string) {
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
            const sessions = await request;
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

    void applySessions(
        fetchApi(sessionListEndpoint, HttpMethod.Post, {
            requestData: {
                folder,
            },
        }),
    );

    return Object.assign(observable, {
        reportError,
        /** Reloads the list for a live session it's missing. */
        sync(sessionStatuses: ReadonlyArray<Readonly<PaneSessionStatus>>) {
            const {sessions, reloadedSessionIds} = observable.value;
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
            void applySessions(
                fetchApi(sessionListEndpoint, HttpMethod.Post, {
                    requestData: {
                        folder,
                    },
                }),
            );
        },
        create(kind: PaneKind) {
            return applySessions(
                fetchApi(sessionCreateEndpoint, HttpMethod.Post, {
                    requestData: {
                        folder,
                        kind,
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
