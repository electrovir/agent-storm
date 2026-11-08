import {
    DiffView,
    ManualReviewStatus,
    PaneKind,
    PaneStatus,
    PaneTabKind,
    restartPaneEndpoint,
    type Config,
    type ManualReviewState,
    type PaneTab,
    type ReviewQueuePr,
    type SessionMeta,
} from '@agent-storm/common';
import {check} from '@augment-vir/assert';
import {getEnumValues, getObjectTypedValues, typedObjectFromEntries} from '@augment-vir/common';
import {HttpMethod} from '@rest-vir/api';
import {css, defineElementEvent, html, listen, nothing, repeat} from 'element-vir';
import {
    createSizedIcon,
    LucideBotIcon,
    LucideFileDiffIcon,
    LucideScanEyeIcon,
    LucideSquareTerminalIcon,
    ViraDropdown,
    viraThemeByKeys,
    type ViraIconSvg,
    type ViraMenuItemEntry,
} from 'vira';
import {fetchApi} from '../../util/api-client.js';
import {type AppContext} from '../../util/app-context.js';
import {createFolderSessions, type FolderSessionsObservable} from '../../util/folder-sessions.js';
import {isNewTabShortcut} from '../../util/keyboard-shortcuts.js';
import {resolveDiffView, resolvePaneState} from '../../util/pane-layout.js';
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
    findTabGroupId,
    isTabLayoutConsistent,
    listDisplayedTabIds,
    sessionPaneKindByTabKind,
    showTabKind,
    syncSessionTabs,
    tabKindByPaneKind,
    toSessionTabId,
    updateTabState,
    type TabLayout,
} from '../../util/tab-layout.js';
import {defineAppElement} from '../define-app-element.js';
import {VirAiPickerModal} from './vir-ai-picker-modal.element.js';
import {VirPaneDiff} from './vir-pane-diff.element.js';
import {VirPaneReview} from './vir-pane-review.element.js';
import {VirPaneTabLabel} from './vir-pane-tab-label.element.js';
import {VirReviewPane} from './vir-review-pane.element.js';
import {VirTabHost, type TabHostNewTabOption, type TabHostTab} from './vir-tab-host.element.js';
import {VirTerminal} from './vir-terminal.element.js';

const diffViewLabels: Readonly<Record<DiffView, string>> = {
    [DiffView.Source]: 'Source',
    [DiffView.ManualReview]: 'Manual review',
};

const sessionKindConfigs: Readonly<
    Record<
        PaneKind,
        Readonly<{
            label: string;
            canChangeAi: boolean;
        }>
    >
> = {
    [PaneKind.Ai]: {
        label: 'AI',
        canChangeAi: true,
    },
    [PaneKind.Shell]: {
        label: 'Shell',
        canChangeAi: false,
    },
};

const tabKindIcons: Readonly<Record<PaneTabKind, ViraIconSvg>> = {
    [PaneTabKind.Ai]: createSizedIcon(LucideBotIcon, 14),
    [PaneTabKind.Shell]: createSizedIcon(LucideSquareTerminalIcon, 14),
    [PaneTabKind.Diff]: createSizedIcon(LucideFileDiffIcon, 14),
    [PaneTabKind.Review]: createSizedIcon(LucideScanEyeIcon, 14),
};

const newTabLabels: Readonly<Record<PaneTabKind, string>> = {
    [PaneTabKind.Ai]: 'AI session',
    [PaneTabKind.Shell]: 'Shell',
    [PaneTabKind.Diff]: 'Diff',
    [PaneTabKind.Review]: 'Review',
};

/** Before a review folder's review branch exists, its diff is meaningless or empty. */
function isReviewFolderDiffAvailable(review: Readonly<ManualReviewState> | undefined) {
    return (
        !!review &&
        review.status !== ManualReviewStatus.Aborted &&
        !(review.status === ManualReviewStatus.Started && review.isPending)
    );
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
            /**
             * Set the first time the Diff tab shows. The diff costs nothing while hidden (no
             * socket, no subprocess), so staying mounted keeps its selected file and scroll
             * position.
             */
            diffMounted: false,
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
                    tabKind: tabKindByPaneKind[kind],
                    session,
                    count: sessions[kind].length,
                };
            });
        });

        const isTabKindAvailable: Readonly<Record<PaneTabKind, boolean>> = {
            [PaneTabKind.Ai]: true,
            [PaneTabKind.Shell]: true,
            [PaneTabKind.Diff]: !isReviewFolder || isReviewFolderDiffAvailable(review),
            [PaneTabKind.Review]: true,
        };

        function isAvailable(tabId: string) {
            const tab = layout.tabs[tabId];
            return (
                !!tab &&
                isTabKindAvailable[tab.kind] &&
                (!sessionPaneKindByTabKind[tab.kind] ||
                    sessionTabs.some((entry) => entry.tabId === tabId))
            );
        }

        const displayedTabIds = listDisplayedTabIds({
            layout,
            isAvailable,
            isMobile,
        });
        const isDiffDisplayed = displayedTabIds.includes(PaneTabKind.Diff);
        const isReviewDisplayed = displayedTabIds.includes(PaneTabKind.Review);

        if (isDiffDisplayed && !state.diffMounted) {
            updateState({
                diffMounted: true,
            });
        }
        paneReview.sync({
            active: inputs.active,
            hasPr,
            isPrNeeded: isDiffDisplayed || isReviewDisplayed,
            isReviewPaneOpen: isReviewDisplayed && inputs.active,
            isDiffMounted: state.diffMounted,
            reviewPullRequest: inputs.reviewPullRequest,
            frontendState: inputs.context.frontendState,
        });

        const diffState = resolvePaneState(
            {
                selectedFolder: inputs.folder,
                diffView: DiffView.Source,
            },
            layout.tabs[PaneTabKind.Diff],
        );
        const diff = resolveDiffView({
            chosen: diffState.diffView,
            hasChanges: !!info?.git.dirty,
            reviewCopyFolder: paneReview.value.reviewCopyFolder,
            review,
            isManualReviewStarting: state.isManualReviewStarting,
        });
        if (state.isManualReviewStarting && diff.isAvailable[DiffView.ManualReview]) {
            updateState({
                isManualReviewStarting: false,
            });
        }

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
        }: Readonly<{
            kind: PaneTabKind;
            groupId: string | undefined;
        }>) {
            const paneKind = sessionPaneKindByTabKind[kind];
            if (!paneKind) {
                writeLayout((current) => {
                    return addTab(current, {
                        tab: {
                            id: kind,
                            kind,
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

        function buildSessionMenu({
            kind,
            session,
            count,
            label,
        }: Readonly<{
            kind: PaneKind;
            session: Readonly<SessionMeta>;
            count: number;
            label: string;
        }>) {
            const entries: ReadonlyArray<ViraMenuItemEntry | undefined> = [
                {
                    content: 'Rename',
                    onClick() {
                        /**
                         * A native prompt rather than a modal: it's the smallest thing that does
                         * the job, and `vir-terminal` already uses `window.prompt` for its paste
                         * fallback.
                         */
                        const name = window.prompt('Session name (empty to use its type):', label);
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
                sessionKindConfigs[kind].canChangeAi
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
            const sessionTab = sessionTabs.find((entry) => entry.tabId === tab.id);
            if (sessionTab) {
                const label = sessionTab.session.name || sessionKindConfigs[sessionTab.kind].label;
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
                            icon: tabKindIcons[tab.kind],
                            ai:
                                sessionTab.kind === PaneKind.Ai
                                    ? findSessionAi(sessionTab.session)
                                    : undefined,
                            status,
                        })}></${VirPaneTabLabel}>
                    `,
                    isAvailable: true,
                    menuEntries: buildSessionMenu({
                        kind: sessionTab.kind,
                        session: sessionTab.session,
                        count: sessionTab.count,
                        label,
                    }),
                };
            }
            return {
                label: html`
                    <${VirPaneTabLabel.assign({
                        label: newTabLabels[tab.kind],
                        icon: tabKindIcons[tab.kind],
                    })}></${VirPaneTabLabel}>
                `,
                isAvailable: isAvailable(tab.id),
                menuEntries: [
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
            .filter((kind) => {
                return (
                    isTabKindAvailable[kind] &&
                    (!!sessionPaneKindByTabKind[kind] || !layout.tabs[kind])
                );
            })
            .map((kind): TabHostNewTabOption => {
                return {
                    label: html`
                        <${VirPaneTabLabel.assign({
                            label: newTabLabels[kind],
                            icon: tabKindIcons[kind],
                            ai:
                                kind === PaneTabKind.Ai
                                    ? aiDefinitions.find(
                                          (definition) => definition.id === folderAiId,
                                      )
                                    : undefined,
                        })}></${VirPaneTabLabel}>
                    `,
                    kind,
                };
            });

        const displayedSessionTabs = sessionTabs
            .filter((entry) => displayedTabIds.includes(entry.tabId))
            .map((entry) => {
                const folderRestartKey =
                    inputs.context.paneRestarts.value.keys[
                        paneRestartKey({
                            folder: inputs.folder,
                            kind: entry.kind,
                        })
                    ] || 0;
                return {
                    ...entry,
                    /**
                     * Folds in both restart counters so either restart remounts the terminal; see
                     * `restartKeys`.
                     */
                    mountKey: `${entry.tabId}:${(state.restartKeys[entry.session.id] || 0) + folderRestartKey}`,
                };
            });

        const isDiffViewSelectable: Readonly<Record<DiffView, boolean>> = {
            [DiffView.Source]: diff.isAvailable[DiffView.Source],
            [DiffView.ManualReview]: diff.isManualReviewSelectable,
        };

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
                    displayedSessionTabs,
                    (entry) => entry.mountKey,
                    (entry) => {
                        return html`
                            <div
                                class="tab-content"
                                slot=${`tab-${entry.tabId}`}
                                ${listen('keydown', async (event) => {
                                    if (isNewTabShortcut(event)) {
                                        event.preventDefault();
                                        await openNewTab({
                                            kind: entry.tabKind,
                                            groupId: findTabGroupId(layout, entry.tabId),
                                        });
                                    }
                                })}
                            >
                                <${VirTerminal.assign({
                                    folder: inputs.folder,
                                    kind: entry.kind,
                                    sessionId: entry.session.id,
                                    active: inputs.active,
                                    showAccessoryKeys: isMobile,
                                    focusOnMount: state.sessionToFocus === entry.session.id,
                                    isFocused: state.focusedTabId === entry.tabId,
                                })}></${VirTerminal}>
                            </div>
                        `;
                    },
                )}
                ${state.diffMounted
                    ? html`
                          <div class="tab-content" slot=${`tab-${PaneTabKind.Diff}`}>
                              <${VirPaneDiff.assign({
                                  folder: diffState.selectedFolder,
                                  isShown: isDiffDisplayed && inputs.active,
                                  diffView: diff.diffView,
                                  paneReview,
                                  isReviewCopyReady: diff.isAvailable[DiffView.ManualReview],
                                  isReviewFolder,
                                  frontendState: inputs.context.frontendState,
                                  screenSize: inputs.context.screenSize,
                                  sourcePicker: html`
                                      <${ViraDropdown.assign({
                                          options: getEnumValues(DiffView).map((view) => {
                                              return {
                                                  value: view,
                                                  label: diffViewLabels[view],
                                                  disabled: !isDiffViewSelectable[view],
                                              };
                                          }),
                                          selected: [
                                              diff.diffView,
                                          ],
                                      })}
                                          ${listen(
                                              ViraDropdown.events.selectedValuesChange,
                                              (event) => {
                                                  const view = event.detail[0];
                                                  if (check.isEnumValue(view, DiffView)) {
                                                      writeLayout((current) => {
                                                          return updateTabState(current, {
                                                              tabId: PaneTabKind.Diff,
                                                              state: {
                                                                  diffView: view,
                                                              },
                                                          });
                                                      });
                                                      updateState({
                                                          isManualReviewStarting: false,
                                                      });
                                                  }
                                              },
                                          )}
                                      ></${ViraDropdown}>
                                  `,
                              })}></${VirPaneDiff}>
                          </div>
                      `
                    : nothing}
                ${isTabKindAvailable[PaneTabKind.Review] && layout.tabs[PaneTabKind.Review]
                    ? html`
                          <div class="tab-content" slot=${`tab-${PaneTabKind.Review}`}>
                              <${VirPaneReview.assign({
                                  folder: inputs.folder,
                                  paneReview,
                                  frontendState: inputs.context.frontendState,
                                  isMobile,
                                  initialPromptSentAt: inputs.reviewStart?.reviewUpdatedAt,
                              })}
                                  ${listen(VirReviewPane.events.manualReviewStarted, () => {
                                      if (!isReviewFolder) {
                                          writeLayout((current) => {
                                              return updateTabState(
                                                  addTab(current, {
                                                      tab: {
                                                          id: PaneTabKind.Diff,
                                                          kind: PaneTabKind.Diff,
                                                      },
                                                      isBackground: true,
                                                  }),
                                                  {
                                                      tabId: PaneTabKind.Diff,
                                                      state: {
                                                          diffView: DiffView.ManualReview,
                                                      },
                                                  },
                                              );
                                          });
                                          updateState({
                                              isManualReviewStarting: true,
                                          });
                                      }
                                  })}
                              ></${VirPaneReview}>
                          </div>
                      `
                    : nothing}
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
