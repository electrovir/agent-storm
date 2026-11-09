import {
    PaneKind,
    PaneStatus,
    restartPaneEndpoint,
    type PaneTab,
    type SessionMeta,
} from '@agent-storm/common';
import {assertWrap, check} from '@augment-vir/assert';
import {
    arrayToObject,
    getEnumValues,
    getObjectTypedValues,
    typedObjectFromEntries,
} from '@augment-vir/common';
import {HttpMethod} from '@rest-vir/api';
import {css, html, listen, nothing, repeat} from 'element-vir';
import {
    createSizedIcon,
    LucideCircleQuestionMarkIcon,
    tooltip,
    viraThemeByKeys,
    type ViraMenuItemEntry,
} from 'vira';
import {fetchApi} from '../../util/api-client.js';
import {createFolderSessions, type FolderSessionsObservable} from '../../util/folder-sessions.js';
import {resolveTabState} from '../../util/pane-layout.js';
import {paneRestartKey} from '../../util/pane-restarts.js';
import {
    PaneMounting,
    type AnyPaneDefinition,
    type AppContext,
    type NewTabRequest,
    type PaneGroupExtensionInputs,
    type PaneGroupView,
    type SessionTab,
} from '../../util/plugin-api.js';
import {ScreenSize} from '../../util/screen-size.js';
import {
    addTab,
    closeTab,
    createDefaultTabLayout,
    createTabId,
    findSessionPaneKind,
    isTabLayoutConsistent,
    listDisplayedTabIds,
    renameTab,
    showTabKind,
    syncSessionTabs,
    toSessionTabId,
    type TabLayout,
} from '../../util/tab-layout.js';
import {defineAppElement} from '../define-app-element.js';
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

/** A folder's tabs: its sessions and every plugin's panes. */
export const VirPaneGroup = defineAppElement<{
    folder: string;
    /** True when this pane-group is the user's currently focused folder. */
    active: boolean;
    context: AppContext;
    /** What this folder's parent hands each plugin's pane group extension, by extension id. */
    extensionInputs?: PaneGroupExtensionInputs | undefined;
}>()({
    tagName: 'vir-pane-group',
    state() {
        return {
            /** Created in `init`, which has the folder. */
            folderSessions: undefined as FolderSessionsObservable | undefined,
            /** Each extension's state, created in `init` and destroyed with the pane group. */
            extensionRuns: {} as PaneGroupView['extensionRuns'],
            extensionListeners: [] as ReadonlyArray<() => void>,
            /** Every tab that has been on screen, for panes that stay mounted once shown. */
            shownTabIds: [] as ReadonlyArray<string>,
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
    init({inputs, updateState, host}) {
        const folderSessions = createFolderSessions(inputs.folder);
        const extensionRuns = arrayToObject(inputs.context.paneGroupExtensions, (extension) => {
            return {
                key: extension.id,
                value: extension.create({
                    folder: inputs.folder,
                    context: inputs.context,
                    folderSessions,
                }),
            };
        });
        updateState({
            folderSessions,
            extensionRuns,
            /** Element-vir only watches observables held directly in state, not inside a record. */
            extensionListeners: getObjectTypedValues(extensionRuns).map((run) => {
                return run.listen(false, () => {
                    host.requestUpdate();
                });
            }),
        });
    },
    cleanup({state}) {
        state.folderSessions?.destroy();
        state.extensionListeners.forEach((removeListener) => removeListener());
        getObjectTypedValues(state.extensionRuns).forEach((run) => run.destroy());
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
         * 16px apart), so the tab strip below it stays clear of them. The symmetric horizontal padding
         * keeps the name centered while clearing them.
         */
        .folder-name-bar {
            display: flex;
            align-items: center;
            justify-content: center;
            box-sizing: border-box;
            min-height: 32px;
            padding: 0 74px;
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
    render({inputs, state, updateState}) {
        const {folderSessions} = state;
        if (!folderSessions) {
            return '';
        }
        const uiLayout = inputs.context.uiLayout;
        const info = inputs.context.folderData.value.folderInfo.get(inputs.folder);
        const isMobile = inputs.context.screenSize === ScreenSize.Mobile;
        const extensionInputs = inputs.extensionInputs || {};
        const hasPr = !!info?.prUrl;
        const sessions = folderSessions.value.sessions;
        const sessionError = folderSessions.value.error;

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
                    panes: inputs.context.panes,
                    extensionInputs,
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
                };
            });
        });

        const view: PaneGroupView = {
            folder: inputs.folder,
            context: inputs.context,
            isActive: inputs.active,
            isMobile,
            layout,
            extensionInputs,
            extensionRuns: state.extensionRuns,
            writeLayout,
            openNewTab,
            sessionToFocus: state.sessionToFocus,
            focusedTabId: state.focusedTabId,
        };

        const panesById: Readonly<Record<string, AnyPaneDefinition | undefined>> = arrayToObject(
            inputs.context.panes,
            (pane) => {
                return {
                    key: pane.id,
                    value: pane,
                };
            },
        );

        function isAvailable(tabId: string) {
            const tab = layout.tabs[tabId];
            return (
                !!tab &&
                !!panesById[tab.kind]?.isAvailable(view) &&
                (!findSessionPaneKind(tab.kind) ||
                    sessionTabs.some((entry) => entry.tabId === tabId))
            );
        }

        const displayedTabIds = listDisplayedTabIds({
            layout,
            isAvailable,
            isMobile,
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
        inputs.context.paneGroupExtensions.forEach((extension) => {
            extension.sync({
                run: assertWrap.isDefined(state.extensionRuns[extension.id]),
                inputs: extensionInputs[extension.id],
                view,
                displayedTabIds,
                shownTabIds: state.shownTabIds,
                hasPr,
            });
        });

        /** The last page load's answer stands in until this one's first poll. */
        const aiFolderInfo =
            info ||
            inputs.context.folderData.value.snapshot?.folders.find(
                (folder) => folder.path === inputs.folder,
            );
        const aiDefinitions = [
            ...(inputs.context.folderData.value.snapshot?.settings.aiDefinitions || []),
            ...(aiFolderInfo?.folderAiDefinitions || []),
        ];
        const folderAiId = aiFolderInfo?.aiId || '';

        /**
         * The AI a session runs: while its process is alive, the one it was started with, since
         * changing the AI doesn't restart every tab. Otherwise its own override, else the
         * folder's.
         */
        function findSessionAi(session: Readonly<SessionMeta>, status: PaneStatus) {
            const isLive = [
                PaneStatus.Busy,
                PaneStatus.Idle,
                PaneStatus.Stalled,
            ].includes(status);
            return (
                (isLive
                    ? aiDefinitions.find((definition) => definition.id === session.launchedAiId)
                    : undefined) ||
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

        async function openNewTab({kind, groupId, state: tabState}: NewTabRequest) {
            const paneKind = findSessionPaneKind(kind);
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
            sessionTab: {kind, session},
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
                {
                    content: 'Close',
                    onClick() {
                        void folderSessions?.close({
                            kind,
                            sessionId: session.id,
                        });
                    },
                },
            ];
            return entries.filter(check.isTruthy);
        }

        function describeTab(tab: Readonly<PaneTab>): TabHostTab {
            const definition = panesById[tab.kind];
            /** A tab whose pane isn't registered can only be closed. */
            if (!definition) {
                return {
                    label: html`
                        <${VirPaneTabLabel.assign({
                            label: tab.name || tab.kind,
                            icon: createSizedIcon(LucideCircleQuestionMarkIcon, 14),
                        })}></${VirPaneTabLabel}>
                    `,
                    isAvailable: false,
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
            const tabState = resolveTabState({
                tabStateShape: definition.tabStateShape,
                tabState: tab.state,
            });
            const sessionTab = sessionTabs.find((entry) => entry.tabId === tab.id);
            if (sessionTab) {
                const label =
                    sessionTab.session.name ||
                    definition.label({
                        tabState,
                        context: inputs.context,
                    });
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
                            ai: definition.hasAi
                                ? findSessionAi(sessionTab.session, status)
                                : undefined,
                            status,
                        })}
                            ${renderKindTooltip({
                                name: sessionTab.session.name,
                                kindLabel: definition.label({
                                    tabState,
                                    context: inputs.context,
                                }),
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
            const label =
                tab.name ||
                definition.label({
                    tabState,
                    context: inputs.context,
                });
            return {
                label: html`
                    <${VirPaneTabLabel.assign({
                        label,
                        icon: definition.icon,
                    })}
                        ${renderKindTooltip({
                            name: tab.name,
                            kindLabel: definition.label({
                                tabState,
                                context: inputs.context,
                            }),
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

        const newTabOptions = inputs.context.panes
            .filter((pane) => pane.isAvailable(view))
            .flatMap((pane) => {
                return pane.newTabEntries(view).map((entry): TabHostNewTabOption => {
                    return {
                        label: html`
                            <${VirPaneTabLabel.assign({
                                label: entry.label,
                                icon: pane.icon,
                                ai: pane.hasAi
                                    ? aiDefinitions.find(
                                          (definition) => definition.id === folderAiId,
                                      )
                                    : undefined,
                            })}></${VirPaneTabLabel}>
                        `,
                        kind: pane.id,
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
                const pane = panesById[tab.kind];
                return !!pane && isMountedBy[pane.mounting];
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
                    pane: assertWrap.isDefined(panesById[tab.kind]),
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
                                ${entry.pane.render({
                                    ...view,
                                    tabId: entry.tab.id,
                                    kind: entry.tab.kind,
                                    tabState: resolveTabState({
                                        tabStateShape: entry.pane.tabStateShape,
                                        tabState: entry.tab.state,
                                    }),
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
