import {
    configEndpoint,
    PaneStatus,
    restartPaneEndpoint,
    type AiDefinition,
    type Config,
    type PaneKind,
    type PaneSessionStatus,
    type SessionMeta,
} from '@agent-storm/common';
import {clamp} from '@augment-vir/common';
import {HttpMethod} from '@rest-vir/api';
import {css, html, listen, nothing, repeat} from 'element-vir';
import {ViraButton, ViraColorVariant, ViraEmphasis, ViraSize, viraThemeByKeys} from 'vira';
import {fetchApi} from '../../util/api-client.js';
import {sessionAtIndex, type FolderSessionsObservable} from '../../util/folder-sessions.js';
import {isNewTabShortcut} from '../../util/keyboard-shortcuts.js';
import {selectPaneSession} from '../../util/router.js';
import {defineAppElement} from '../define-app-element.js';
import {VirAiPickerModal} from './vir-ai-picker-modal.element.js';
import {VirSessionTab} from './vir-session-tab.element.js';
import {VirTerminal} from './vir-terminal.element.js';

/**
 * One pane of a folder's pane group: its session tabs and the active session's terminal. The host
 * is the pane, so the pane group sizes and hides it directly.
 */
export const VirSessionPane = defineAppElement<{
    folder: string;
    /** What the session tab selection is remembered under. */
    memoryKey: string;
    kind: PaneKind;
    folderSessions: FolderSessionsObservable;
    /**
     * 1-based index of the active session tab, straight from the URL. An index past the end of the
     * folder's list falls back to the first session.
     */
    sessionIndex: number;
    /**
     * True when this pane's group is the user's currently focused folder. Forwarded to the
     * `VirTerminal` so it can re-fit and push a fresh size to the server when transitioning to
     * visible — a CSS-hidden pane may have missed window-resize events while it was `display:
     * none`.
     */
    active: boolean;
    isMobile: boolean;
    /** Whether to mount the terminal rather than leave the pane empty. */
    mountTerminal: boolean;
    /**
     * Counter bumped by `vir-app` whenever something outside this element restarts the folder's
     * panes (the sidebar's "Change AI" and "Restart panes"). Folded into the terminal's mount key
     * so the element is recreated — `VirTerminal` opens its socket in `onDomCreated`, which never
     * re-runs for a reused element.
     */
    folderRestartKey: number;
    /**
     * Live status of each session the daemon holds a PTY for, refreshed by `vir-app`'s folder poll.
     * {@link PaneStatus.Busy} is what spins that tab's activity indicator. A session with no entry
     * (no PTY yet) reads as not busy.
     */
    sessionStatuses: ReadonlyArray<Readonly<PaneSessionStatus>>;
    /** Whether this pane shows the folder's session errors. */
    showError: boolean;
    /** Given to an AI pane, whose tabs each run one of the user's AI definitions. */
    ai?:
        | Readonly<{
              /**
               * Backend-resolved AI id for this folder (per-folder override → worktree-root →
               * global default). Each AI tab uses it unless the tab carries an override of its own.
               * Empty when the user has defined no AI at all.
               */
              folderAiId: string;
              parentRepoPath: string;
              aiConfigRevision: number;
          }>
        | undefined;
}>()({
    tagName: 'vir-session-pane',
    state() {
        return {
            /**
             * Per-session remount counters, keyed by session id. Bumping one forces its
             * `VirTerminal` to unmount and remount, which is how a restart gets a fresh socket
             * against the newly-spawned PTY (the terminal bakes its connection into `onDomCreated`,
             * which does not re-run on input changes).
             */
            restartKeys: {} as Readonly<Record<string, number | undefined>>,
            /**
             * The tab just created here, whose terminal should grab focus when it mounts. Cleared
             * by the next `focusin`, so switching back to that tab later doesn't steal focus
             * again.
             */
            sessionToFocus: undefined as string | undefined,
            /**
             * The user's AI definitions, needed to show each AI tab's avatar and to populate the
             * "Change AI" picker. Loaded once per mount and re-read after a change, since the pane
             * group is keyed by folder and remounts on a folder switch anyway.
             */
            aiDefinitions: [] as ReadonlyArray<AiDefinition>,
            resolvedFolderAiId: undefined as string | undefined,
            loadedAiConfigRevision: undefined as number | undefined,
            /** Session the "Change AI" picker is open for. Undefined when closed. */
            changeAiSessionId: undefined as string | undefined,
            changeAiSubmitting: false,
        };
    },
    styles: css`
        :host {
            flex-basis: 0;
            min-width: 0;
            min-height: 0;
            overflow: hidden;
            transition: filter 120ms ease;
            /* Column so the session sub-tab strip sits above the terminal in normal flow. */
            display: flex;
            flex-direction: column;
            /* Anchor for .session-add-floating. */
            position: relative;
        }

        /*
         * Session sub-tab strip, nested under the CLI/Code (or AI/Shell/Code) tab bar. Rendered only
         * when a pane has more than one session so single-session users lose no vertical space; the
         * "+" control lives in the pane's hover affordance instead (see .session-add-floating).
         */
        .pane-content {
            display: contents;
        }

        .session-bar {
            flex-grow: 0;
            flex-shrink: 0;
            display: flex;
            align-items: center;
            gap: 2px;
            padding: 2px 4px;
            box-sizing: border-box;
            /*
             * Must stay overflow: visible. Any scroll/hidden value here establishes a clipping box
             * that cuts off each tab's pop-up menu — and setting only overflow-x makes overflow-y
             * compute to auto, so it clips vertically too. Tabs wrap to a second line instead of
             * scrolling; their labels are usually a single digit, so wrapping is rare.
             */
            flex-wrap: wrap;
            border-bottom: 1px solid
                ${viraThemeByKeys.grey['behind-bg'].decoration.background.value};
            font-size: 11px;
            /* Keep the strip from being squeezed out when the terminal wants all the height. */
            min-height: 26px;
        }

        .pane-body {
            /* Fill whatever the session strip leaves behind. */
            flex-grow: 1;
            flex-shrink: 1;
            min-height: 0;
        }

        /*
         * When a pane has a single session there's no tab strip, so this is the only way to create a
         * second one. Floated over the terminal's top-right rather than taking flow space, and only
         * opaque on pane hover, so a user who never wants multiple sessions never sees it. Absolute
         * positioning (rather than collapsing the strip's height) avoids re-triggering an xterm refit
         * on every hover.
         */
        .session-add-floating {
            position: absolute;
            top: 2px;
            right: 2px;
            z-index: 2;
            opacity: 0;
            transition: opacity 120ms ease;
        }

        :host(:hover) .session-add-floating,
        .session-add-floating:focus-within {
            opacity: 1;
        }

        .session-error {
            padding: 2px 6px;
            color: ${viraThemeByKeys.red.foreground.body.foreground.value};
            font-size: 11px;
        }
    `,
    render({inputs, state, updateState}) {
        const {sessions: folderSessions, error} = inputs.folderSessions.value;
        const sessions = folderSessions?.[inputs.kind];
        const ai = inputs.ai;

        function resolveFolderAiId(config: Readonly<Config>) {
            const folderOverrideId = config.folderAiIds.find(
                (entry) => entry.folder === inputs.folder,
            )?.aiId;
            const parentOverrideId = ai?.parentRepoPath
                ? config.folderAiIds.find((entry) => entry.folder === ai.parentRepoPath)?.aiId
                : undefined;
            return (
                folderOverrideId ||
                parentOverrideId ||
                config.defaultAiId ||
                config.aiDefinitions[0]?.id ||
                ''
            );
        }

        async function loadAiDefinitions() {
            try {
                const config = await fetchApi(configEndpoint, HttpMethod.Get);
                updateState({
                    aiDefinitions: config.aiDefinitions,
                    resolvedFolderAiId: resolveFolderAiId(config),
                });
            } catch (error: unknown) {
                inputs.folderSessions.reportError(error);
            }
        }

        if (ai && state.loadedAiConfigRevision !== ai.aiConfigRevision) {
            updateState({
                loadedAiConfigRevision: ai.aiConfigRevision,
            });
            void loadAiDefinitions();
        }

        const currentFolderAiId = state.resolvedFolderAiId || ai?.folderAiId;

        /**
         * The AI a tab runs: its own override, else whatever the folder resolved to. Undefined when
         * the definitions haven't loaded yet or the user has defined no AI.
         */
        function aiForSession(session: Readonly<SessionMeta>) {
            return (
                state.aiDefinitions.find((definition) => definition.id === session.aiId) ||
                state.aiDefinitions.find((definition) => definition.id === currentFolderAiId)
            );
        }

        /**
         * The incoming index is a hint — it comes from the URL, which in turn comes from what this
         * folder was last on, and either can name a session that has since been closed. Correcting
         * it back to the first session here rather than only falling back at render time is what
         * makes the route and the remembered value agree with what's on screen, and it's also what
         * clears the stale memory. Only the active folder owns the URL, so an inactive pane
         * correcting it would clobber.
         */
        if (sessions && inputs.active && inputs.sessionIndex > Math.max(1, sessions.length)) {
            selectPaneSession({
                memoryKey: inputs.memoryKey,
                kind: inputs.kind,
                index: 1,
            });
        }

        function selectSession(index: number) {
            selectPaneSession({
                memoryKey: inputs.memoryKey,
                kind: inputs.kind,
                index,
            });
        }

        function bumpRestartKey(sessionId: string) {
            updateState({
                restartKeys: {
                    ...state.restartKeys,
                    [sessionId]: (state.restartKeys[sessionId] || 0) + 1,
                },
            });
        }

        async function onAddSession() {
            const createdSessions = await inputs.folderSessions.create(inputs.kind);
            if (!createdSessions) {
                return;
            }
            updateState({
                sessionToFocus: createdSessions[inputs.kind].at(-1)?.id,
            });
            /** Jump to the session just created — it's appended, so it's the last one. */
            selectSession(createdSessions[inputs.kind].length);
        }

        async function restartSession(sessionId: string) {
            await fetchApi(restartPaneEndpoint, HttpMethod.Post, {
                requestData: {
                    folder: inputs.folder,
                    kind: inputs.kind,
                    sessionId,
                },
            });
            bumpRestartKey(sessionId);
        }

        /**
         * Save a tab's AI, then restart it: a running pane keeps whatever command it was spawned
         * with, so without the restart the new avatar would disagree with what's actually running.
         */
        async function onChangeSessionAi(aiId: string) {
            const sessionId = state.changeAiSessionId;
            if (!sessionId || state.changeAiSubmitting) {
                return;
            }
            updateState({
                changeAiSubmitting: true,
            });
            const savedSessions = await inputs.folderSessions.setAi({
                kind: inputs.kind,
                sessionId,
                aiId,
            });
            try {
                if (savedSessions) {
                    await restartSession(sessionId);
                    updateState({
                        changeAiSessionId: undefined,
                    });
                }
            } catch (error) {
                inputs.folderSessions.reportError(error);
            }
            updateState({
                changeAiSubmitting: false,
            });
        }

        async function onCloseSession(session: Readonly<SessionMeta>, index: number) {
            const remainingSessions = await inputs.folderSessions.close({
                kind: inputs.kind,
                sessionId: session.id,
            });
            if (!remainingSessions) {
                return;
            }
            /**
             * Keep the selection in range after a removal. Closing the active tab (or any tab
             * before it) shifts everything left, so clamp to the new length.
             */
            selectSession(
                clamp(inputs.sessionIndex > index ? inputs.sessionIndex - 1 : inputs.sessionIndex, {
                    min: 1,
                    max: remainingSessions[inputs.kind].length,
                }),
            );
        }

        const addSessionButton = html`
            <${ViraButton.assign({
                buttonSize: ViraSize.Small,
                buttonEmphasis: ViraEmphasis.Subtle,
                color: ViraColorVariant.Neutral,
                text: '+',
            })}
                title="New session"
                ${listen('click', onAddSession)}
            ></${ViraButton}>
        `;

        const activeSession = sessions && sessionAtIndex(sessions, inputs.sessionIndex);
        /**
         * Mount exactly one terminal per pane: the active session's. Inactive sessions keep their
         * PTY alive on the daemon and replay scrollback on reattach, so holding a socket open for
         * each would buy nothing but idle connections. The `repeat` key combines the session id
         * with its restart counter so both switching tabs and restarting force a fresh element —
         * `VirTerminal` opens its socket in `onDomCreated`, which never re-runs for a reused
         * element.
         */
        const terminalMountKey = activeSession
            ? `${activeSession.id}:${(state.restartKeys[activeSession.id] || 0) + inputs.folderRestartKey}`
            : '';

        /** What the "Change AI" picker shows as "Inherit": the folder's AI. */
        const folderAiName =
            state.aiDefinitions.find((definition) => definition.id === currentFolderAiId)?.name ||
            '';

        return html`
            <div
                class="pane-content"
                ${listen('focusin', () => {
                    updateState({
                        sessionToFocus: undefined,
                    });
                })}
                ${listen('keydown', async (event) => {
                    if (isNewTabShortcut(event)) {
                        event.preventDefault();
                        await onAddSession();
                    }
                })}
            >
                ${sessions && sessions.length > 1
                    ? html`
                          <div class="session-bar" role="tablist" aria-label="Sessions">
                              ${repeat(
                                  sessions,
                                  (session) => session.id,
                                  (session, index) => {
                                      return html`
                                          <${VirSessionTab.assign({
                                              session,
                                              kind: inputs.kind,
                                              index,
                                              isSelected: session.id === activeSession?.id,
                                              status:
                                                  inputs.sessionStatuses.find((entry) => {
                                                      return (
                                                          entry.kind === inputs.kind &&
                                                          entry.sessionId === session.id
                                                      );
                                                  })?.status ?? PaneStatus.None,
                                              ai: ai ? aiForSession(session) : undefined,
                                              canChangeAi: !!ai,
                                              canClose: sessions.length > 1,
                                          })}
                                              ${listen(VirSessionTab.events.selected, () => {
                                                  selectSession(index + 1);
                                              })}
                                              ${listen(VirSessionTab.events.renamed, (event) => {
                                                  return inputs.folderSessions.rename({
                                                      kind: inputs.kind,
                                                      sessionId: session.id,
                                                      name: event.detail,
                                                  });
                                              })}
                                              ${listen(
                                                  VirSessionTab.events.restartRequested,
                                                  () => {
                                                      return restartSession(session.id).catch(
                                                          inputs.folderSessions.reportError,
                                                      );
                                                  },
                                              )}
                                              ${listen(
                                                  VirSessionTab.events.changeAiRequested,
                                                  () => {
                                                      updateState({
                                                          changeAiSessionId: session.id,
                                                          changeAiSubmitting: false,
                                                      });
                                                      return loadAiDefinitions();
                                                  },
                                              )}
                                              ${listen(VirSessionTab.events.closeRequested, () => {
                                                  return onCloseSession(session, index);
                                              })}
                                          ></${VirSessionTab}>
                                      `;
                                  },
                              )}
                              ${addSessionButton}
                          </div>
                      `
                    : html`
                          <span class="session-add-floating">${addSessionButton}</span>
                      `}
                ${inputs.showError && error
                    ? html`
                          <div class="session-error" role="alert">${error}</div>
                      `
                    : nothing}
                <div class="pane-body">
                    ${inputs.mountTerminal && activeSession
                        ? repeat(
                              [terminalMountKey],
                              (key) => key,
                              () => {
                                  return html`
                                      <${VirTerminal.assign({
                                          folder: inputs.folder,
                                          kind: inputs.kind,
                                          sessionId: activeSession.id,
                                          active: inputs.active,
                                          showAccessoryKeys: inputs.isMobile,
                                          focusOnMount: state.sessionToFocus === activeSession.id,
                                      })}></${VirTerminal}>
                                  `;
                              },
                          )
                        : nothing}
                </div>
            </div>
            ${ai
                ? html`
                      <${VirAiPickerModal.assign({
                          open: !!state.changeAiSessionId,
                          modalTitle: 'Change AI for this tab',
                          aiDefinitions: state.aiDefinitions,
                          selectedAiId:
                              sessions?.find((session) => session.id === state.changeAiSessionId)
                                  ?.aiId || '',
                          inheritedName: folderAiName,
                          submitting: state.changeAiSubmitting,
                      })}
                          ${listen(VirAiPickerModal.events.closeRequested, () => {
                              updateState({
                                  changeAiSessionId: undefined,
                                  changeAiSubmitting: false,
                              });
                          })}
                          ${listen(VirAiPickerModal.events.aiSaveRequested, (event) => {
                              return onChangeSessionAi(event.detail);
                          })}
                      ></${VirAiPickerModal}>
                  `
                : nothing}
        `;
    },
});
