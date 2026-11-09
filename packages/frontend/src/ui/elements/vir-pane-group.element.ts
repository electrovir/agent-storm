import {
    DiffView,
    PaneKind,
    PaneStatus,
    PaneTabKind,
    restartPaneEndpoint,
    type Config,
    type PaneState,
    type PaneTab,
    type ReviewQueuePr,
    type SessionMeta,
} from '@agent-storm/common';
import {check} from '@augment-vir/assert';
import {getEnumValues, getObjectTypedValues, typedObjectFromEntries} from '@augment-vir/common';
import {HttpMethod} from '@rest-vir/api';
import {css, defineElementEvent, html, listen, nothing, repeat} from 'element-vir';
import {tooltip, viraThemeByKeys, type ViraMenuItemEntry} from 'vira';
import {fetchApi} from '../../util/api-client.js';
import {type AppContext} from '../../util/app-context.js';
import {createFolderSessions, type FolderSessionsObservable} from '../../util/folder-sessions.js';
import {resolvePaneState} from '../../util/pane-layout.js';
import {paneRestartKey} from '../../util/pane-restarts.js';
import {
    createPaneReview,
    type PaneReviewObservable,
    type ReviewStart,
} from '../../util/pane-review.js';
import {ScreenSize} from '../../util/screen-size.js';
import {
    addTab,
    closeTab,
    createDefaultTabLayout,
    createTabId,
    hasTabOfKind,
    isTabLayoutConsistent,
    listDisplayedTabIds,
    renameTab,
    sessionPaneKindByTabKind,
    showTabKind,
    syncSessionTabs,
    toSessionTabId,
    type TabLayout,
} from '../../util/tab-layout.js';
import {defineAppElement} from '../define-app-element.js';
import {
    paneDefinitions,
    PaneMounting,
    type PaneGroupView,
    type SessionTab,
} from './pane-definitions.js';
import {VirAiPickerModal} from './vir-ai-picker-modal.element.js';
import {VirPaneTabLabel} from './vir-pane-tab-label.element.js';
import {VirTabHost, type TabHostNewTabOption, type TabHostTab} from './vir-tab-host.element.js';

/** Names a renamed tab's kind, which its name hides. An unnamed tab already shows its kind. */
function renderKindTooltip({
    name,
    kindLabel,
}: Readonly<{
    name: string | undefined;
    kindLabel: string;
}>) {
    return name
        ? tooltip(kindLabel, {
              delay: {
                  milliseconds: 100,
              },
          })
        : nothing;
}

/** A folder's tabs: its AI and Shell sessions, its diff, and its PR's review. */
export const VirPaneGroup = defineAppElement<{
    folder: string;
    /** True when this pane-group is the user's currently focused folder. */
    active: boolean;
    context: AppContext;
    /**
     * Set when the folder is a pull request's review folder. Holds the Diff tab back until the
     * manual review's startup has finished.
     */
    reviewPullRequest?: Readonly<ReviewQueuePr> | undefined;
    /** Typed into the AI session once the folder's sessions load, unless it's already been sent. */
    reviewStart?: Readonly<ReviewStart> | undefined;
}>()({
    tagName: 'vir-pane-group',
    events: {
        /** The parent should set the `reviewStart` it passed in as sent. */
        reviewStartSent: defineElementEvent<void>(),
    },
    state() {
        return {
            /** Created in `init`, which has the folder. */
            folderSessions: undefined as FolderSessionsObservable | undefined,
            paneReview: undefined as PaneReviewObservable | undefined,
            /** Every tab that has been on screen, for panes that stay mounted once shown. */
            shownTabIds: [] as ReadonlyArray<string>,
            /** Keeps the Diff tab on the manual review while its copy is still being made. */
            isManualReviewStarting: false,
            /**
             * Per-session remount counters. Bumping one remounts its `VirTerminal`, which is how a
             * restart gets a fresh socket: the terminal connects in `onDomCreated`, which doesn't
             * re-run for a reused element.
             */
            restartKeys: {} as Readonly<Record<string, number | undefined>>,
            /**
             * The session just created here, whose terminal grabs focus when it mounts. Cleared by
             * the next `focusin`, so showing that tab again later doesn't steal focus.
             */
            sessionToFocus: undefined as string | undefined,
            /** The tab in the pane group the user last focused. */
            focusedTabId: undefined as string | undefined,
            /** Session the "Change AI" picker is open for. Undefined when closed. */
            changeAiSessionId: undefined as string | undefined,
            changeAiSubmitting: false,
        };
    },
    init({inputs, updateState}) {
        const folderSessions = createFolderSessions(inputs.folder);
        updateState({
            folderSessions,
            paneReview: createPaneReview({
                folder: inputs.folder,
                uiLayout: inputs.context.uiLayout,
                folderSessions,
            }),
        });
    },
    cleanup({state}) {
        state.folderSessions?.destroy();
        state.paneReview?.destroy();
    },
    styles: css`
        :host {
            display: flex;
            flex-direction: column;
            width: 100%;
            height: 100%;
        }

        /*
         * Mobile-only strip naming the active folder. It has to fully contain
         * vir-mobile-sidebar's absolutely-positioned hamburger and gear (6px inset on two 24px buttons
         * 4px apart), so the tab strip below it stays clear of them. The symmetric horizontal padding
         * keeps the name centered while clearing them.
         */
        .folder-name-bar {
            display: flex;
            align-items: center;
            justify-content: center;
            box-sizing: border-box;
            min-height: 32px;
            padding: 0 62px;
            border-bottom: 1px solid
                ${viraThemeByKeys.grey['behind-bg'].decoration.background.value};
        }

        .folder-name-label {
            min-width: 0;
            overflow: hidden;
            white-space: nowrap;
            text-overflow: ellipsis;
            font-size: 12px;
            font-weight: 600;
            color: ${viraThemeByKeys.grey.foreground.body.foreground.value};
        }

        .session-error {
            padding: 2px 6px;
            color: ${viraThemeByKeys.red.foreground.body.foreground.value};
            font-size: 11px;
        }

        ${VirTabHost} {
            flex-grow: 1;
            min-height: 0;
        }

        .tab-content {
            position: relative;
            display: flex;
            flex-direction: column;
            flex-grow: 1;
            min-height: 0;
            min-width: 0;
        }
    `,
    render({inputs, state, updateState, dispatch, events}) {
        const {folderSessions, paneReview} = state;
        if (!folderSessions || !paneReview) {
            return '';
        }
        const uiLayout = inputs.context.uiLayout;
        const info = inputs.context.folderData.value.folderInfo.get(inputs.folder);
        const isMobile = inputs.context.screenSize === ScreenSize.Mobile;
        const isReviewFolder = !!inputs.reviewPullRequest;
        const hasPr = !!info?.prUrl;
        const sessions = folderSessions.value.sessions;
        const sessionError = folderSessions.value.error;
        const review = paneReview.value.review;

        folderSessions.sync(info?.sessionStatuses || []);

        const folderNameBar = isMobile
            ? html`
                  <div class="folder-name-bar" title=${inputs.folder}>
                      <span class="folder-name-label">
                          ${inputs.folder.split('/').findLast(Boolean) || inputs.folder}
                      </span>
                  </div>
              `
            : nothing;
        const errorLine = sessionError
            ? html`
                  <div class="session-error" role="alert">${sessionError}</div>
              `
            : nothing;

        const sharedLayout = uiLayout.value.layout?.tabLayouts[inputs.folder];
        if (!sessions || !uiLayout.value.layout) {
            return html`
                ${folderNameBar} ${errorLine}
            `;
        }

        function writeLayout(change: (current: Readonly<TabLayout>) => Readonly<TabLayout>) {
            uiLayout.updateTabLayout({
                folder: inputs.folder,
                update(current) {
                    return current && change(current);
                },
            });
        }

        function syncAllSessionTabs(layout: Readonly<TabLayout>) {
            return getEnumValues(PaneKind).reduce((current: Readonly<TabLayout>, kind) => {
                return syncSessionTabs(current, {
                    kind,
                    sessionIds: (sessions?.[kind] || []).map((session) => session.id),
                });
            }, layout);
        }

        /** A stored layout the reducers can't trust is replaced, as if the folder had none. */
        const baseLayout =
            sharedLayout && isTabLayoutConsistent(sharedLayout)
                ? uiLayout.getTabLayout(inputs.folder)
                : undefined;
        const initialLayout =
            baseLayout ||
            [
                uiLayout.takeShowRequest(inputs.folder),
            ].reduce(
                (layout: Readonly<TabLayout>, kind) => (kind ? showTabKind(layout, kind) : layout),
                createDefaultTabLayout({
                    sessions,
                    isReviewFolder,
                }),
            );
        if (!baseLayout) {
            uiLayout.updateTabLayout({
                folder: inputs.folder,
                update() {
                    return initialLayout;
                },
            });
        }
        const layout = syncAllSessionTabs(initialLayout);
        /**
         * Only the window the user is in writes session changes back, so a window still holding an
         * older session list can't close the tab of a session another window just opened.
         */
        if (
            baseLayout &&
            layout !== baseLayout &&
            inputs.active &&
            document.visibilityState === 'visible'
        ) {
            writeLayout(syncAllSessionTabs);
        }

        const sessionTabs = getEnumValues(PaneKind).flatMap((kind) => {
            return sessions[kind].map((session) => {
                return {
                    tabId: toSessionTabId({
                        kind,
                        sessionId: session.id,
                    }),
                    kind,
                    session,
                    count: sessions[kind].length,
                };
            });
        });

        const view: PaneGroupView = {
            folder: inputs.folder,
            context: inputs.context,
            isActive: inputs.active,
            isMobile,
            isReviewFolder,
            layout,
            paneReview,
            review,
            reviewStart: inputs.reviewStart,
            isManualReviewStarting: state.isManualReviewStarting,
            setManualReviewStarting(isManualReviewStarting) {
                updateState({
                    isManualReviewStarting,
                });
            },
            writeLayout,
            openNewTab,
            sessionToFocus: state.sessionToFocus,
            focusedTabId: state.focusedTabId,
        };

        function isAvailable(tabId: string) {
            const tab = layout.tabs[tabId];
            return (
                !!tab &&
                paneDefinitions[tab.kind].isAvailable(view) &&
                (!sessionPaneKindByTabKind[tab.kind] ||
                    sessionTabs.some((entry) => entry.tabId === tabId))
            );
        }

        const displayedTabIds = listDisplayedTabIds({
            layout,
            isAvailable,
            isMobile,
        });
        const isDiffDisplayed = hasTabOfKind(layout, {
            tabIds: displayedTabIds,
            kind: PaneTabKind.Diff,
        });
        const isReviewDisplayed = hasTabOfKind(layout, {
            tabIds: displayedTabIds,
            kind: PaneTabKind.Review,
        });
        const newlyShownTabIds = displayedTabIds.filter(
            (tabId) => !state.shownTabIds.includes(tabId),
        );
        if (newlyShownTabIds.length) {
            updateState({
                shownTabIds: [
                    ...state.shownTabIds,
                    ...newlyShownTabIds,
                ],
            });
        }
        paneReview.sync({
            active: inputs.active,
            hasPr,
            isPrNeeded: isDiffDisplayed || isReviewDisplayed,
            isReviewPaneOpen: isReviewDisplayed && inputs.active,
            isDiffMounted:
                hasTabOfKind(layout, {
                    tabIds: state.shownTabIds,
                    kind: PaneTabKind.Diff,
                }) || isDiffDisplayed,
            reviewPullRequest: inputs.reviewPullRequest,
            frontendState: inputs.context.frontendState,
        });

        if (
            inputs.reviewStart &&
            paneReview.sendReviewStart({
                reviewStart: inputs.reviewStart,
                isMobile,
            })
        ) {
            dispatch(
                new events.reviewStartSent({
                    detail: undefined,
                }),
            );
        }

        function resolveFolderAiId(config: Readonly<Config>) {
            const folderOverrideId = config.folderAiIds.find(
                (entry) => entry.folder === inputs.folder,
            )?.aiId;
            const parentOverrideId = info?.parentRepoPath
                ? config.folderAiIds.find((entry) => entry.folder === info.parentRepoPath)?.aiId
                : undefined;
            return (
                folderOverrideId ||
                parentOverrideId ||
                config.defaultAiId ||
                config.aiDefinitions[0]?.id ||
                ''
            );
        }

        const config = inputs.context.folderData.value.snapshot?.config;
        const aiDefinitions = config?.aiDefinitions || [];
        const folderAiId = config ? resolveFolderAiId(config) : '';

        /** The AI a session runs: its own override, else the folder's. */
        function findSessionAi(session: Readonly<SessionMeta>) {
            return (
                aiDefinitions.find((definition) => definition.id === session.aiId) ||
                aiDefinitions.find((definition) => definition.id === folderAiId)
            );
        }

        async function restartSession({
            kind,
            sessionId,
        }: Readonly<{
            kind: PaneKind;
            sessionId: string;
        }>) {
            await fetchApi(restartPaneEndpoint, HttpMethod.Post, {
                requestData: {
                    folder: inputs.folder,
                    kind,
                    sessionId,
                },
            });
            updateState({
                restartKeys: {
                    ...state.restartKeys,
                    [sessionId]: (state.restartKeys[sessionId] || 0) + 1,
                },
            });
        }

        /**
         * Saves a session's AI, then restarts it: a running session keeps whatever command it was
         * spawned with.
         */
        async function changeSessionAi(aiId: string) {
            const sessionId = state.changeAiSessionId;
            if (!sessionId || state.changeAiSubmitting || !folderSessions) {
                return;
            }
            updateState({
                changeAiSubmitting: true,
            });
            const savedSessions = await folderSessions.setAi({
                kind: PaneKind.Ai,
                sessionId,
                aiId,
            });
            try {
                if (savedSessions) {
                    await restartSession({
                        kind: PaneKind.Ai,
                        sessionId,
                    });
                    updateState({
                        changeAiSessionId: undefined,
                    });
                }
            } catch (error) {
                folderSessions.reportError(error);
            }
            updateState({
                changeAiSubmitting: false,
            });
        }

        async function openNewTab({
            kind,
            groupId,
            state: tabState,
        }: Readonly<{
            kind: PaneTabKind;
            groupId: string | undefined;
            state?: Readonly<Partial<PaneState>> | undefined;
        }>) {
            const paneKind = sessionPaneKindByTabKind[kind];
            if (!paneKind) {
                writeLayout((current) => {
                    return addTab(current, {
                        tab: {
                            id: createTabId(kind),
                            kind,
                            state: tabState && {
                                ...tabState,
                            },
                        },
                        groupId,
                    });
                });
                return;
            }
            const createdSessions = await folderSessions?.create(paneKind);
            const sessionId = createdSessions?.[paneKind].at(-1)?.id;
            if (!sessionId) {
                return;
            }
            updateState({
                sessionToFocus: sessionId,
            });
            writeLayout((current) => {
                return addTab(current, {
                    tab: {
                        id: toSessionTabId({
                            kind: paneKind,
                            sessionId,
                        }),
                        kind,
                    },
                    groupId,
                });
            });
        }

        /**
         * A native prompt rather than a modal: it's the smallest thing that does the job, and
         * `vir-terminal` already uses `window.prompt` for its paste fallback.
         */
        function promptTabName(label: string) {
            return window.prompt('Tab name (empty to use its type):', label) ?? undefined;
        }

        function buildSessionMenu({
            sessionTab: {kind, session, count},
            label,
            hasAi,
        }: Readonly<{
            sessionTab: SessionTab;
            label: string;
            hasAi: boolean;
        }>) {
            const entries: ReadonlyArray<ViraMenuItemEntry | undefined> = [
                {
                    content: 'Rename',
                    onClick() {
                        const name = promptTabName(label);
                        if (name != undefined) {
                            void folderSessions?.rename({
                                kind,
                                sessionId: session.id,
                                name,
                            });
                        }
                    },
                },
                {
                    content: 'Restart',
                    onClick() {
                        void restartSession({
                            kind,
                            sessionId: session.id,
                        }).catch((error: unknown) => folderSessions?.reportError(error));
                    },
                },
                hasAi
                    ? {
                          content: 'Change AI',
                          onClick() {
                              updateState({
                                  changeAiSessionId: session.id,
                                  changeAiSubmitting: false,
                              });
                          },
                      }
                    : undefined,
                /** A folder always keeps one session of each kind. */
                count > 1
                    ? {
                          content: 'Close',
                          onClick() {
                              void folderSessions?.close({
                                  kind,
                                  sessionId: session.id,
                              });
                          },
                      }
                    : undefined,
            ];
            return entries.filter(check.isTruthy);
        }

        function describeTab(tab: Readonly<PaneTab>): TabHostTab {
            const definition = paneDefinitions[tab.kind];
            const sessionTab = sessionTabs.find((entry) => entry.tabId === tab.id);
            if (sessionTab) {
                const label = sessionTab.session.name || definition.label(tab.state);
                const status =
                    info?.sessionStatuses.find((entry) => {
                        return (
                            entry.kind === sessionTab.kind &&
                            entry.sessionId === sessionTab.session.id
                        );
                    })?.status ?? PaneStatus.None;
                return {
                    label: html`
                        <${VirPaneTabLabel.assign({
                            label,
                            icon: definition.icon,
                            ai: definition.hasAi ? findSessionAi(sessionTab.session) : undefined,
                            status,
                        })}
                            ${renderKindTooltip({
                                name: sessionTab.session.name,
                                kindLabel: definition.label(tab.state),
                            })}
                        ></${VirPaneTabLabel}>
                    `,
                    isAvailable: true,
                    menuEntries: buildSessionMenu({
                        sessionTab,
                        label,
                        hasAi: definition.hasAi,
                    }),
                };
            }
            const label = tab.name || definition.label(tab.state);
            return {
                label: html`
                    <${VirPaneTabLabel.assign({
                        label,
                        icon: definition.icon,
                    })}
                        ${renderKindTooltip({
                            name: tab.name,
                            kindLabel: definition.label(tab.state),
                        })}
                    ></${VirPaneTabLabel}>
                `,
                isAvailable: isAvailable(tab.id),
                menuEntries: [
                    {
                        content: 'Rename',
                        onClick() {
                            const name = promptTabName(label);
                            if (name != undefined) {
                                writeLayout((current) => {
                                    return renameTab(current, {
                                        tabId: tab.id,
                                        name,
                                    });
                                });
                            }
                        },
                    },
                    {
                        content: 'Close',
                        onClick() {
                            writeLayout((current) => closeTab(current, tab.id));
                        },
                    },
                ],
            };
        }

        const newTabOptions = getEnumValues(PaneTabKind)
            .filter((kind) => paneDefinitions[kind].isAvailable(view))
            .flatMap((kind) => {
                return paneDefinitions[kind]
                    .newTabEntries(view)
                    .map((entry): TabHostNewTabOption => {
                        return {
                            label: html`
                                <${VirPaneTabLabel.assign({
                                    label: entry.label,
                                    icon: paneDefinitions[kind].icon,
                                    ai: paneDefinitions[kind].hasAi
                                        ? aiDefinitions.find(
                                              (definition) => definition.id === folderAiId,
                                          )
                                        : undefined,
                                })}></${VirPaneTabLabel}>
                            `,
                            kind,
                            state: entry.state,
                        };
                    });
            });

        const mountedTabs = getObjectTypedValues(layout.tabs)
            .filter((tab) => {
                const isDisplayed = displayedTabIds.includes(tab.id);
                const isMountedBy: Readonly<Record<PaneMounting, boolean>> = {
                    [PaneMounting.WhileDisplayed]: isDisplayed,
                    [PaneMounting.OnceDisplayed]: isDisplayed || state.shownTabIds.includes(tab.id),
                    [PaneMounting.Always]: isAvailable(tab.id),
                };
                return isMountedBy[paneDefinitions[tab.kind].mounting];
            })
            .map((tab) => {
                const sessionTab = sessionTabs.find((entry) => entry.tabId === tab.id);
                const restartCount = sessionTab
                    ? (state.restartKeys[sessionTab.session.id] || 0) +
                      (inputs.context.paneRestarts.value.keys[
                          paneRestartKey({
                              folder: inputs.folder,
                              kind: sessionTab.kind,
                          })
                      ] || 0)
                    : 0;
                return {
                    tab,
                    sessionTab,
                    /**
                     * Folds in both restart counters so either restart remounts the terminal; see
                     * `restartKeys`.
                     */
                    mountKey: `${tab.id}:${restartCount}`,
                };
            });

        const selectedAiId =
            sessions[PaneKind.Ai].find((session) => session.id === state.changeAiSessionId)?.aiId ||
            '';

        return html`
            ${folderNameBar} ${errorLine}
            <${VirTabHost.assign({
                layout,
                tabs: typedObjectFromEntries(
                    getObjectTypedValues(layout.tabs).map((tab) => {
                        return [
                            tab.id,
                            describeTab(tab),
                        ];
                    }),
                ),
                newTabOptions,
                isMobile,
            })}
                ${listen(VirTabHost.events.layoutChanged, (event) => {
                    uiLayout.updateTabLayout({
                        folder: inputs.folder,
                        update() {
                            return event.detail;
                        },
                    });
                })}
                ${listen(VirTabHost.events.newTabRequested, async (event) => {
                    await openNewTab(event.detail);
                })}
                ${listen(VirTabHost.events.focusedTabChanged, (event) => {
                    updateState({
                        focusedTabId: event.detail,
                    });
                })}
                ${listen('focusin', () => {
                    if (state.sessionToFocus) {
                        updateState({
                            sessionToFocus: undefined,
                        });
                    }
                })}
            >
                ${repeat(
                    mountedTabs,
                    (entry) => entry.mountKey,
                    (entry) => {
                        return html`
                            <div class="tab-content" slot=${`tab-${entry.tab.id}`}>
                                ${paneDefinitions[entry.tab.kind].render({
                                    ...view,
                                    tabId: entry.tab.id,
                                    kind: entry.tab.kind,
                                    paneState: resolvePaneState(
                                        {
                                            selectedFolder: inputs.folder,
                                            diffView: DiffView.Source,
                                            diffSelections: {},
                                            activityPaths: [],
                                        },
                                        entry.tab,
                                    ),
                                    isDisplayed: displayedTabIds.includes(entry.tab.id),
                                    sessionTab: entry.sessionTab,
                                })}
                            </div>
                        `;
                    },
                )}
            </${VirTabHost}>
            <${VirAiPickerModal.assign({
                open: !!state.changeAiSessionId,
                modalTitle: 'Change AI for this tab',
                aiDefinitions,
                selectedAiId,
                inheritedName:
                    aiDefinitions.find((definition) => definition.id === folderAiId)?.name || '',
                submitting: state.changeAiSubmitting,
            })}
                ${listen(VirAiPickerModal.events.closeRequested, () => {
                    updateState({
                        changeAiSessionId: undefined,
                        changeAiSubmitting: false,
                    });
                })}
                ${listen(VirAiPickerModal.events.aiSaveRequested, async (event) => {
                    await changeSessionAi(event.detail);
                })}
            ></${VirAiPickerModal}>
        `;
    },
});
