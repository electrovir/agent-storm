// cspell:words titlebar, grabbable

import {PaneKind, type FolderSessions, type SessionMeta} from '@agent-storm/common';
import {css, defineElement, defineElementEvent, html, listen, repeat} from 'element-vir';
import {
    HorizontalAnchor,
    renderMenuItemEntries,
    ViraButton,
    ViraColorVariant,
    ViraEmphasis,
    ViraMenuTrigger,
    ViraSize,
    viraThemeByKeys,
    type ViraMenuItemEntry,
} from 'vira';
import {
    closeSession,
    createSession,
    getFolderSessions,
    renameSession,
    resetAiSession,
    restartPane,
} from '../../util/api-client.js';
import {localStorageClient, paneSplit} from '../../util/local-storage-client.js';
import {type FrontendTab} from '../../util/router.js';
import {ScreenSize} from '../../util/screen-size.js';
import {VirDiffPane} from './vir-diff-pane.element.js';
import {VirTerminal} from './vir-terminal.element.js';

/** Tab label: the user's name when set, otherwise the tab's 1-based position. */
function sessionLabel(session: Readonly<SessionMeta>, index: number): string {
    return session.name || String(index + 1);
}

/**
 * Resolve a 1-based URL index to a live session. An index can outlive the session it referenced
 * (the tab was closed, or the folder's list shrank), so anything out of range falls back to the
 * first session rather than rendering an empty pane.
 */
function sessionAtIndex(
    sessions: ReadonlyArray<Readonly<SessionMeta>>,
    oneBasedIndex: number,
): SessionMeta | undefined {
    return sessions[oneBasedIndex - 1] || sessions[0];
}

function clampSplit(value: number): number {
    if (!Number.isFinite(value)) {
        return paneSplit.default;
    }
    return Math.min(paneSplit.max, Math.max(paneSplit.min, value));
}

export const VirPaneGroup = defineElement<{
    folder: string;
    aiHidden: boolean;
    /**
     * True when this pane-group is the user's currently focused folder. Forwarded to each
     * `VirTerminal` so they can re-fit and push a fresh size to the server when transitioning to
     * visible — a CSS-hidden pane may have missed window-resize events while it was `display:
     * none`.
     */
    active: boolean;
    /**
     * Currently-active tab — `'ai' | 'shell' | 'diff'`. Driven by the `?tab=...` param at the app
     * level so the URL is the source of truth. On desktop, both `ai` and `shell` render the CLI
     * layout (split panes); on mobile each value shows exactly one pane.
     */
    activeTab: FrontendTab;
    /**
     * Coarse viewport bucket from `vir-app`'s state. Controls the tab layout (2 tabs vs 3) and the
     * pane-visibility rules. Updates as the user resizes the window.
     */
    screenSize: ScreenSize;
    aiRestartKey: number;
    /**
     * 1-based index of the active session tab for each pane, straight from the URL. Two values
     * because desktop shows both panes at once, so each has its own independent selection. An index
     * past the end of the folder's list falls back to the first session.
     */
    aiSessionIndex: number;
    shellSessionIndex: number;
    /**
     * Backend-resolved "reset AI session" command for this folder (per-folder override → global
     * default). Empty means not configured, which hides the corresponding session-menu item — same
     * signal the sidebar row menu used.
     */
    resetAiSessionCmd: string;
}>()({
    tagName: 'vir-pane-group',
    events: {
        /**
         * Emitted when the user clicks one of the tab buttons. Parent should update the `?tab=...`
         * URL param to the requested value (the actual route paths stay the same).
         */
        tabRequested: defineElementEvent<FrontendTab>(),
        /**
         * Emitted when the user selects (or creates, or closes into) a different session tab.
         * Carries the 1-based index the URL should now hold for that pane kind.
         */
        sessionRequested: defineElementEvent<{kind: PaneKind; index: number}>(),
    },
    state() {
        return {
            split: localStorageClient.paneSplit.read(),
            dragging: false,
            /**
             * Session tab lists for this folder, both kinds. Undefined until the first `/sessions`
             * load resolves; the panes render nothing until then so a terminal never mounts against
             * a guessed session id.
             */
            sessions: undefined as FolderSessions | undefined,
            sessionsRequested: false,
            sessionsError: undefined as string | undefined,
            /**
             * Per-session remount counters, keyed `${kind}:${sessionId}`. Bumping one forces its
             * `VirTerminal` to unmount and remount, which is how a restart gets a fresh socket
             * against the newly-spawned PTY (the terminal bakes its connection into `onDomCreated`,
             * which does not re-run on input changes).
             */
            restartKeys: {} as Record<string, number | undefined>,
            /**
             * Which pane last received focus inside this group. Sticky across window blur/focus
             * cycles: a `:focus-within` CSS-based highlight loses match when the user cmd+tabs away
             * (xterm's hidden textarea blurs and doesn't reliably regain focus through the shadow
             * boundary on return), so we mirror focus into local state and drive the highlight off
             * that instead. Undefined before the user has clicked into either pane.
             */
            focusedKind: undefined as PaneKind | undefined,
            /**
             * Set true the first time the user opens the Diff tab, and never reset. The diff pane
             * costs nothing while hidden (it holds no socket and no subprocess), so keeping it
             * mounted preserves its selected file and scroll position across tab switches.
             */
            diffMounted: false,
        };
    },
    styles: css`
        :host {
            display: flex;
            flex-direction: column;
            width: 100%;
            height: 100%;
        }

        /*
         * Mobile-only strip naming the active folder. Sits above the tab bar and has to fully
         * contain vir-app's absolutely-positioned hamburger (top-left of the stage, 6px inset on a
         * 24px button), so the tab bar below it stays clear of the hamburger and needs no left
         * padding of its own. 32px is that button's extent and nothing more — this strip is pure
         * overhead on a phone screen. The symmetric horizontal padding keeps the name centered
         * while clearing the hamburger.
         */
        .folder-name-bar {
            flex-grow: 0;
            flex-shrink: 0;
            display: flex;
            align-items: center;
            justify-content: center;
            box-sizing: border-box;
            min-height: 32px;
            padding: 0 34px;
            border-bottom: 1px solid
                ${viraThemeByKeys.grey['behind-bg'].decoration.background.value};
        }

        .folder-name-label {
            min-width: 0;
            overflow: hidden;
            white-space: nowrap;
            text-overflow: ellipsis;
            font-family: ui-sans-serif, system-ui, sans-serif;
            font-size: 12px;
            font-weight: 600;
            color: ${viraThemeByKeys.grey.foreground.body.foreground.value};
        }

        .tab-bar {
            display: flex;
            flex: 0 0 auto;
            border-bottom: 1px solid
                ${viraThemeByKeys.grey['behind-bg'].decoration.background.value};
            font-family: ui-sans-serif, system-ui, sans-serif;
            font-size: 12px;
        }

        .tab {
            appearance: none;
            background: transparent;
            border: none;
            border-bottom: 2px solid transparent;
            padding: 6px 14px;
            cursor: pointer;
            color: ${viraThemeByKeys.grey.foreground['non-body'].foreground.value};
            font: inherit;
            letter-spacing: 0.02em;
            transition:
                color 120ms ease,
                border-bottom-color 120ms ease;
        }

        .tab:hover {
            color: ${viraThemeByKeys.grey.foreground.body.foreground.value};
        }

        .tab[data-selected] {
            color: ${viraThemeByKeys.blue.foreground.body.foreground.value};
            border-bottom-color: ${viraThemeByKeys.blue.foreground.body.foreground.value};
        }

        .body {
            display: flex;
            flex-direction: row;
            flex: 1 1 auto;
            min-height: 0;
            width: 100%;
            position: relative;
        }

        .diff-pane,
        .cli-panes {
            position: absolute;
            inset: 0;
            display: flex;
            flex-direction: row;
            overflow: hidden;
        }

        .diff-pane[data-hidden],
        .cli-panes[data-hidden] {
            /*
             * Keep the hidden side mounted so its scroll position and, for the terminals, their
             * live PTY sockets survive a tab switch. Hiding by visibility preserves all of that,
             * and killing pointer events makes the hidden side inert to clicks.
             */
            visibility: hidden;
            pointer-events: none;
        }

        .pane {
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

        .ai-pane {
            flex-grow: var(--ai-grow, 0.5);
        }

        .shell-pane {
            flex-grow: var(--shell-grow, 0.5);
            border-left: 1px solid ${viraThemeByKeys.grey.foreground.body.foreground.value};
        }

        /* Dim whichever pane isn't the last-focused one so it's obvious which one keystrokes
           will land in. Driven by an explicit data attribute (see focusedKind in state) rather
           than :focus-within so the highlight survives cmd+tab away/back — xterm's hidden
           textarea blurs on window blur and doesn't reliably refocus on return, which would
           otherwise drop the indicator. */
        .pane[data-pane-focused='false'] {
            filter: brightness(0.75) saturate(0.9);
        }

        /*
         * Session sub-tab strip, nested under the CLI/Code (or AI/Shell/Code) tab bar. Rendered only
         * when a pane has more than one session so single-session users lose no vertical space; the
         * "+" control lives in the pane's hover affordance instead (see .session-add).
         */
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
            font-family: ui-sans-serif, system-ui, sans-serif;
            font-size: 11px;
            /* Keep the strip from being squeezed out when the terminal wants all the height. */
            min-height: 26px;
        }

        .session-tab {
            display: inline-flex;
            align-items: center;
            gap: 2px;
            flex-shrink: 0;
            padding: 2px 4px 2px 8px;
            border: 1px solid transparent;
            border-radius: 4px;
            cursor: pointer;
            color: ${viraThemeByKeys.grey.foreground['non-body'].foreground.value};
            background: transparent;
            font: inherit;
            max-width: 160px;
        }

        .session-tab:hover {
            color: ${viraThemeByKeys.grey.foreground.body.foreground.value};
            background: ${viraThemeByKeys.grey['behind-fg']['small-body'].background.value};
        }

        .session-tab[data-selected] {
            color: ${viraThemeByKeys.blue.foreground.body.foreground.value};
            border-color: ${viraThemeByKeys.blue.foreground.decoration.foreground.value};
        }

        .session-tab-label {
            min-width: 0;
            overflow: hidden;
            white-space: nowrap;
            text-overflow: ellipsis;
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

        .pane:hover .session-add-floating,
        .session-add-floating:focus-within {
            opacity: 1;
        }

        .session-error {
            padding: 2px 6px;
            color: ${viraThemeByKeys.red.foreground.body.foreground.value};
            font-family: ui-sans-serif, system-ui, sans-serif;
            font-size: 11px;
        }

        .divider {
            flex: 0 0 4px;
            position: relative;
            cursor: col-resize;
            background: ${viraThemeByKeys.grey['behind-bg'].decoration.background.value};
            transition: background 120ms ease;
            /* Sit above the panes so the hit-area extension below catches the pointer
               instead of being eaten by terminal mousedown handlers. */
            z-index: 1;
            touch-action: none;
        }

        /* Visible bar stays a thin 4px, but the user gets ~14px of grabbable surface. */
        .divider::before {
            content: '';
            position: absolute;
            top: 0;
            bottom: 0;
            left: -5px;
            right: -5px;
        }

        .divider:hover,
        .divider.dragging {
            background: ${viraThemeByKeys.grey.foreground.body.foreground.value};
        }

        /*
         * Mobile layout overrides: hide the inactive pane and the resize divider so the active
         * pane fills the available area. Driven by a data-mobile attribute on .cli-panes (toggled
         * from the render based on the screenSize input).
         */
        .cli-panes[data-mobile] .divider,
        .cli-panes[data-mobile] .pane[data-hidden] {
            display: none;
        }

        .cli-panes[data-mobile] .pane:not([data-hidden]) {
            flex-grow: 1;
        }
    `,
    render({inputs, state, updateState, host, dispatch, events}) {
        /**
         * Load this folder's session tabs once per mount. The pane group is keyed by folder up in
         * `vir-app`, so a folder switch mounts a fresh element and re-runs this.
         */
        if (!state.sessionsRequested) {
            updateState({
                sessionsRequested: true,
            });
            void getFolderSessions({
                folder: inputs.folder,
            })
                .then((sessions) => {
                    updateState({
                        sessions,
                        sessionsError: undefined,
                    });
                })
                .catch((error: unknown) => {
                    updateState({
                        sessionsError: error instanceof Error ? error.message : String(error),
                    });
                });
        }

        /** Replace the local list after any mutation so tab order and names match the server. */
        const applySessions = (sessions: FolderSessions) => {
            updateState({
                sessions,
                sessionsError: undefined,
            });
        };

        const reportSessionError = (error: unknown) => {
            updateState({
                sessionsError: error instanceof Error ? error.message : String(error),
            });
        };

        const bumpRestartKey = (kind: PaneKind, sessionId: string) => {
            const key = `${kind}:${sessionId}`;
            updateState({
                restartKeys: {
                    ...state.restartKeys,
                    [key]: (state.restartKeys[key] || 0) + 1,
                },
            });
        };

        const sessionIndexFor = (kind: PaneKind): number =>
            kind === PaneKind.Ai ? inputs.aiSessionIndex : inputs.shellSessionIndex;

        const onAddSession = (kind: PaneKind) => {
            void createSession({
                folder: inputs.folder,
                kind,
            })
                .then((sessions) => {
                    applySessions(sessions);
                    /** Jump to the session just created — it's appended, so it's the last one. */
                    dispatch(
                        new events.sessionRequested({
                            kind,
                            index: sessions[kind].length,
                        }),
                    );
                })
                .catch(reportSessionError);
        };

        const onRenameSession = (kind: PaneKind, session: Readonly<SessionMeta>, index: number) => {
            /**
             * A native prompt rather than a modal: it's the smallest thing that does the job, and
             * `vir-terminal` already uses `window.prompt` for its paste fallback. Worth upgrading
             * to an inline input if renaming turns out to be frequent.
             */
            const nextName = window.prompt(
                'Session name (empty to use its number):',
                session.name || String(index + 1),
            );
            if (nextName == undefined) {
                return;
            }
            void renameSession({
                folder: inputs.folder,
                kind,
                sessionId: session.id,
                name: nextName,
            })
                .then(applySessions)
                .catch(reportSessionError);
        };

        const onRestartSession = (kind: PaneKind, session: Readonly<SessionMeta>) => {
            void restartPane({
                folder: inputs.folder,
                kind,
                sessionId: session.id,
            })
                .then(() => bumpRestartKey(kind, session.id))
                .catch(reportSessionError);
        };

        const onResetAiSession = (session: Readonly<SessionMeta>) => {
            void resetAiSession({
                folder: inputs.folder,
                sessionId: session.id,
            })
                .then(() => bumpRestartKey(PaneKind.Ai, session.id))
                .catch(reportSessionError);
        };

        const onCloseSession = (kind: PaneKind, session: Readonly<SessionMeta>, index: number) => {
            void closeSession({
                folder: inputs.folder,
                kind,
                sessionId: session.id,
            })
                .then((sessions) => {
                    applySessions(sessions);
                    /**
                     * Keep the selection in range after a removal. Closing the active tab (or any
                     * tab before it) shifts everything left, so clamp to the new length.
                     */
                    const nextIndex = Math.min(
                        Math.max(
                            1,
                            sessionIndexFor(kind) > index
                                ? sessionIndexFor(kind) - 1
                                : sessionIndexFor(kind),
                        ),
                        sessions[kind].length,
                    );
                    dispatch(
                        new events.sessionRequested({
                            kind,
                            index: nextIndex,
                        }),
                    );
                })
                .catch(reportSessionError);
        };

        /**
         * Per-tab menu. Restart / reset live here rather than on the folder's sidebar row because
         * with several sessions per pane, "restart the AI" is only meaningful against a specific
         * one.
         */
        const buildSessionMenuEntries = ({
            kind,
            session,
            index,
            sessionCount,
        }: Readonly<{
            kind: PaneKind;
            session: Readonly<SessionMeta>;
            index: number;
            sessionCount: number;
        }>): ReadonlyArray<ViraMenuItemEntry> => {
            /**
             * Annotated so each literal widens to `ViraMenuItemEntry` (whose `content` is an
             * `HtmlInterpolation`, not a `string`) before the conditional entries are filtered
             * out.
             */
            const entries: ReadonlyArray<ViraMenuItemEntry | undefined> = [
                {
                    content: 'Rename',
                    onClick: () => onRenameSession(kind, session, index),
                },
                {
                    content: 'Restart',
                    onClick: () => onRestartSession(kind, session),
                },
                kind === PaneKind.Ai && inputs.resetAiSessionCmd
                    ? {
                          content: 'New AI session',
                          onClick: () => onResetAiSession(session),
                      }
                    : undefined,
                {
                    content: 'New tab',
                    onClick: () => onAddSession(kind),
                },
                /** The last remaining tab can't be closed — a pane with no tabs has nothing to show. */
                sessionCount > 1
                    ? {
                          content: 'Close',
                          onClick: () => onCloseSession(kind, session, index),
                      }
                    : undefined,
            ];
            return entries.filter((entry): entry is ViraMenuItemEntry => !!entry);
        };

        /**
         * Sole "new session" affordance for a pane showing one session, where the tab strip (and so
         * its `+`) is hidden.
         */
        const renderFloatingAddSession = (kind: PaneKind) => html`
            <span class="session-add-floating">
                <${ViraButton.assign({
                    buttonSize: ViraSize.Small,
                    buttonEmphasis: ViraEmphasis.Subtle,
                    color: ViraColorVariant.Neutral,
                    text: '+',
                })}
                    title="New session"
                    ${listen('click', () => onAddSession(kind))}
                ></${ViraButton}>
            </span>
        `;

        const renderSessionBar = (
            kind: PaneKind,
            sessions: ReadonlyArray<Readonly<SessionMeta>>,
        ) => {
            const activeSession = sessionAtIndex(sessions, sessionIndexFor(kind));
            return html`
                <div class="session-bar" role="tablist" aria-label="Sessions">
                    ${repeat(
                        sessions,
                        (session) => session.id,
                        (session, index) => html`
                            <div
                                class="session-tab"
                                role="tab"
                                ?data-selected=${session.id === activeSession?.id}
                                aria-selected=${session.id === activeSession?.id}
                                title=${session.name || `Session ${index + 1}`}
                                ${listen('click', () =>
                                    dispatch(
                                        new events.sessionRequested({
                                            kind,
                                            index: index + 1,
                                        }),
                                    ),
                                )}
                            >
                                <span class="session-tab-label">
                                    ${sessionLabel(session, index)}
                                </span>
                                <span ${listen('click', (event) => event.stopPropagation())}>
                                    <${ViraMenuTrigger.assign({
                                        horizontalAnchor: HorizontalAnchor.Right,
                                    })}>
                                        <${ViraButton.assign({
                                            buttonSize: ViraSize.Small,
                                            buttonEmphasis: ViraEmphasis.Subtle,
                                            color: ViraColorVariant.Neutral,
                                            text: '⋮',
                                        })}
                                            slot=${ViraMenuTrigger.slotNames[
                                                'vira-menu-trigger-trigger'
                                            ]}
                                            title="Session actions"
                                        ></${ViraButton}>
                                        ${renderMenuItemEntries(
                                            buildSessionMenuEntries({
                                                kind,
                                                session,
                                                index,
                                                sessionCount: sessions.length,
                                            }),
                                        )}
                                    </${ViraMenuTrigger}>
                                </span>
                            </div>
                        `,
                    )}
                    <${ViraButton.assign({
                        buttonSize: ViraSize.Small,
                        buttonEmphasis: ViraEmphasis.Subtle,
                        color: ViraColorVariant.Neutral,
                        text: '+',
                    })}
                        class="session-add"
                        title="New session"
                        ${listen('click', () => onAddSession(kind))}
                    ></${ViraButton}>
                </div>
            `;
        };

        /**
         * Mount exactly one terminal per pane: the active session's. Inactive sessions keep their
         * PTY alive on the daemon and replay scrollback on reattach, so holding a socket open for
         * each would buy nothing but idle connections. The `repeat` key combines the session id
         * with its restart counter so both switching tabs and restarting force a fresh element —
         * `VirTerminal` opens its socket in `onDomCreated`, which never re-runs for a reused
         * element.
         */
        const renderPaneTerminal = (
            kind: PaneKind,
            sessions: ReadonlyArray<Readonly<SessionMeta>>,
        ) => {
            const session = sessionAtIndex(sessions, sessionIndexFor(kind));
            if (!session) {
                return '';
            }
            const folderRestartKey = kind === PaneKind.Ai ? inputs.aiRestartKey : 0;
            const sessionRestartKey = state.restartKeys[`${kind}:${session.id}`] || 0;
            const mountKey = `${session.id}:${sessionRestartKey + folderRestartKey}`;
            return repeat(
                [mountKey],
                (key) => key,
                () => html`
                    <${VirTerminal.assign({
                        folder: inputs.folder,
                        kind,
                        sessionId: session.id,
                        active: inputs.active,
                        showAccessoryKeys: inputs.screenSize === ScreenSize.Mobile,
                    })}></${VirTerminal}>
                `,
            );
        };

        const split = clampSplit(state.split);
        host.style.setProperty('--ai-grow', String(split));
        host.style.setProperty('--shell-grow', String(1 - split));

        const onDividerPointerDown = (event: PointerEvent) => {
            event.preventDefault();
            /**
             * Pointer Events unify mouse, touch, and pen so the same handler covers desktop and
             * iPad. `setPointerCapture` keeps `pointermove`/`pointerup` flowing to this element
             * even if the finger drifts off it mid-drag.
             */
            const divider = event.currentTarget;
            if (divider instanceof Element) {
                divider.setPointerCapture(event.pointerId);
            }

            // Mute selection + force resize cursor globally during drag — otherwise crossing
            // into the xterm canvas flips the cursor to i-beam and selects terminal text.
            const previousUserSelect = document.body.style.userSelect;
            const previousCursor = document.body.style.cursor;
            document.body.style.userSelect = 'none';
            document.body.style.cursor = 'col-resize';

            let latestSplit = split;
            updateState({
                dragging: true,
            });

            const onMove = (moveEvent: PointerEvent) => {
                if (moveEvent.pointerId !== event.pointerId) {
                    return;
                }
                const rect = host.getBoundingClientRect();
                if (rect.width <= 0) {
                    return;
                }
                latestSplit = clampSplit((moveEvent.clientX - rect.left) / rect.width);
                updateState({
                    split: latestSplit,
                });
            };

            const onUp = (upEvent: PointerEvent) => {
                if (upEvent.pointerId !== event.pointerId) {
                    return;
                }
                window.removeEventListener('pointermove', onMove);
                window.removeEventListener('pointerup', onUp);
                window.removeEventListener('pointercancel', onUp);
                document.body.style.userSelect = previousUserSelect;
                document.body.style.cursor = previousCursor;
                updateState({
                    dragging: false,
                });
                localStorageClient.paneSplit.write(latestSplit);
            };

            window.addEventListener('pointermove', onMove);
            window.addEventListener('pointerup', onUp);
            window.addEventListener('pointercancel', onUp);
        };

        const onDividerDoubleClick = () => {
            updateState({
                split: paneSplit.default,
            });
            localStorageClient.paneSplit.write(paneSplit.default);
        };

        /**
         * `focusin` bubbles through the shadow boundary (composed events), so xterm's hidden
         * textarea gaining focus reaches this listener via the outer `.pane` div. Default the
         * highlight to whichever pane is visible first when nothing has been focused yet, so the
         * initial render doesn't show both panes dimmed.
         */
        const focusedKind = state.focusedKind ?? (inputs.aiHidden ? PaneKind.Shell : PaneKind.Ai);
        const aiFocused = focusedKind === PaneKind.Ai;
        const shellFocused = focusedKind === PaneKind.Shell;

        const isDiffTab = inputs.activeTab === 'diff';
        const isMobile = inputs.screenSize === ScreenSize.Mobile;
        /** Basename of the folder path — matches how folder names are derived elsewhere. */
        const folderName = inputs.folder.split('/').findLast(Boolean) || inputs.folder;
        /**
         * Pane visibility decision matrix:
         *
         * - Desktop, tab=ai|shell → both AI + Shell visible (the existing split layout).
         * - Desktop, tab=diff → the diff pane visible (both terminals hidden).
         * - Mobile, tab=ai → only AI pane visible.
         * - Mobile, tab=shell → only Shell pane visible.
         * - Mobile, tab=diff → only the diff pane visible.
         */
        const showCliPanes = !isDiffTab;
        const showAiPane = showCliPanes && (!isMobile || inputs.activeTab === 'ai');
        const showShellPane = showCliPanes && (!isMobile || inputs.activeTab === 'shell');

        /**
         * Whether to actually mount each terminal (vs. just hide it with CSS). On desktop both are
         * always mounted so the split view is live and switching tabs is instant. On mobile only
         * the visible pane's terminal is mounted, so an inactive folder never holds a socket and
         * even the active folder holds at most one `/pty` WebSocket at a time — switching
         * tabs/panes closes the old socket (the daemon keeps the PTY and replays scrollback on the
         * next attach). This keeps phones from accumulating idle sockets.
         */
        const mountAiTerminal = !isMobile || showAiPane;
        const mountShellTerminal = !isMobile || showShellPane;

        if (isDiffTab && !state.diffMounted) {
            updateState({
                diffMounted: true,
            });
        }

        /**
         * Tab bar layout differs by screen size:
         *
         * - Desktop: 3 tabs (CLI, Diff, Code). The CLI tab is the active one when `activeTab` is `ai`
         *   or `shell` — the user can't tell them apart on desktop (both panes are visible) so we
         *   collapse them into one button. Clicking CLI sets `tab=ai` as a stable default.
         * - Mobile: 4 tabs (AI, Shell, Diff, Code), each mapping directly to the URL param.
         */
        const tabButtons: ReadonlyArray<{label: string; tab: FrontendTab; isActive: boolean}> =
            isMobile
                ? [
                      {
                          label: 'AI',
                          tab: 'ai',
                          isActive: inputs.activeTab === 'ai',
                      },
                      {
                          label: 'Shell',
                          tab: 'shell',
                          isActive: inputs.activeTab === 'shell',
                      },
                      {
                          label: 'Diff',
                          tab: 'diff',
                          isActive: isDiffTab,
                      },
                  ]
                : [
                      {
                          label: 'CLI',
                          tab: 'ai',
                          isActive: showCliPanes,
                      },
                      {
                          label: 'Diff',
                          tab: 'diff',
                          isActive: isDiffTab,
                      },
                  ];

        const requestTab = (tab: FrontendTab) => {
            dispatch(new events.tabRequested(tab));
        };

        return html`
            ${isMobile
                ? html`
                      <div class="folder-name-bar" title=${inputs.folder}>
                          <span class="folder-name-label">${folderName}</span>
                      </div>
                  `
                : ''}
            <div class="tab-bar" role="tablist" ?data-mobile=${isMobile}>
                ${tabButtons.map(
                    ({label, tab, isActive}) => html`
                        <button
                            type="button"
                            class="tab"
                            role="tab"
                            ?data-selected=${isActive}
                            aria-selected=${isActive}
                            ${listen('click', () => requestTab(tab))}
                        >
                            ${label}
                        </button>
                    `,
                )}
            </div>
            <div class="body">
                ${state.diffMounted
                    ? html`
                          <div class="diff-pane" ?data-hidden=${!isDiffTab}>
                              <${VirDiffPane.assign({
                                  folder: inputs.folder,
                                  active: isDiffTab && inputs.active,
                                  screenSize: inputs.screenSize,
                              })}></${VirDiffPane}>
                          </div>
                      `
                    : ''}
                <div class="cli-panes" ?data-hidden=${!showCliPanes} ?data-mobile=${isMobile}>
                    ${inputs.aiHidden
                        ? ''
                        : html`
                              <div
                                  class="pane ai-pane"
                                  ?data-hidden=${!showAiPane}
                                  data-pane-focused=${aiFocused ? 'true' : 'false'}
                                  ${listen('focusin', () =>
                                      updateState({
                                          focusedKind: PaneKind.Ai,
                                      }),
                                  )}
                              >
                                  ${state.sessions && state.sessions.ai.length > 1
                                      ? renderSessionBar(PaneKind.Ai, state.sessions.ai)
                                      : renderFloatingAddSession(PaneKind.Ai)}
                                  ${state.sessionsError
                                      ? html`
                                            <div class="session-error" role="alert">
                                                ${state.sessionsError}
                                            </div>
                                        `
                                      : ''}
                                  <div class="pane-body">
                                      ${mountAiTerminal && state.sessions
                                          ? renderPaneTerminal(PaneKind.Ai, state.sessions.ai)
                                          : ''}
                                  </div>
                              </div>
                              <div
                                  class="divider ${state.dragging ? 'dragging' : ''}"
                                  role="separator"
                                  aria-orientation="vertical"
                                  title="Drag to resize. Double-click to reset."
                                  ${listen('pointerdown', onDividerPointerDown)}
                                  ${listen('dblclick', onDividerDoubleClick)}
                              ></div>
                          `}
                    <div
                        class="pane shell-pane"
                        ?data-hidden=${!showShellPane}
                        data-pane-focused=${shellFocused ? 'true' : 'false'}
                        ${listen('focusin', () =>
                            updateState({
                                focusedKind: PaneKind.Shell,
                            }),
                        )}
                    >
                        ${state.sessions && state.sessions.shell.length > 1
                            ? renderSessionBar(PaneKind.Shell, state.sessions.shell)
                            : renderFloatingAddSession(PaneKind.Shell)}
                        <div class="pane-body">
                            ${mountShellTerminal && state.sessions
                                ? renderPaneTerminal(PaneKind.Shell, state.sessions.shell)
                                : ''}
                        </div>
                    </div>
                </div>
            </div>
        `;
    },
});
