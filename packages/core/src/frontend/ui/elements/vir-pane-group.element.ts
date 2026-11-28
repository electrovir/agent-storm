import {
    PaneKind,
    PaneStatus,
    restartPaneEndpoint,
    toPaneGroupKey,
    type PaneTab,
} from '@agent-storm/common';
import {assertWrap} from '@augment-vir/assert';
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
    LucideTriangleAlertIcon,
    tooltip,
    viraThemeByKeys,
    type ViraMenuItemEntry,
} from 'vira';
import {fetchApi} from '../../util/api-client.js';
import {isDebugLogEnabled, logDebug} from '../../util/debug-log.js';
import {createFolderSessions, type FolderSessionsObservable} from '../../util/folder-sessions.js';
import {resolveTabState} from '../../util/pane-layout.js';
import {paneRestartKey} from '../../util/pane-restarts.js';
import {
    PaneMounting,
    SettingsSection,
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
    createTabLayout,
    findSessionPaneKind,
    findTabGroupId,
    isTabLayoutConsistent,
    listDisplayedTabIds,
    moveTab,
    renameTab,
    showTabKind,
    splitTab,
    splitTabLayout,
    syncSessionTabs,
    toSessionTabId,
    type TabLayout,
} from '../../util/tab-layout.js';
import {defineAppElement} from '../define-app-element.js';
import {VirPaneTabLabel} from './vir-pane-tab-label.element.js';
import {VirTabHost, type TabHostNewTabOption, type TabHostTab} from './vir-tab-host.element.js';

/** The last selection logged per pane group, so each render doesn't log an unchanged one. */
const loggedSelections = new Map<string, string>();

/** Each extension's state for one pane group, re-rendering the pane group whenever one changes. */
function startExtensionRuns({
    extensions,
    folder,
    scope,
    context,
    folderSessions,
    host,
}: Readonly<{
    extensions: AppContext['paneGroupExtensions'];
    folder: string;
    scope: string | undefined;
    context: AppContext;
    folderSessions: FolderSessionsObservable;
    host: Readonly<Pick<HTMLElement & {requestUpdate(): void}, 'requestUpdate'>>;
}>) {
    const extensionRuns: PaneGroupView['extensionRuns'] = arrayToObject(extensions, (extension) => {
        return {
            key: extension.id,
            value: extension.create({
                folder,
                layoutKey: toPaneGroupKey({
                    folder,
                    scope,
                }),
                context,
                folderSessions,
            }),
        };
    });
    return {
        extensionRuns,
        /** Element-vir only watches observables held directly in state, not inside a record. */
        extensionListeners: getObjectTypedValues(extensionRuns).map((run) => {
            return run.listen(false, () => {
                host.requestUpdate();
            });
        }),
    };
}

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
    /**
     * Sets this pane group apart from the folder's own: it keeps its own tabs and its own
     * terminals, which still open in the folder. Empty for the folder's own pane group.
     */
    scope?: string | undefined;
    /**
     * What a pane group with no saved layout starts with, instead of the folder's defaults: one
     * list of tabs per group, each showing its first tab.
     */
    defaultTabs?:
        | ReadonlyArray<ReadonlyArray<Readonly<Pick<PaneTab, 'kind' | 'state'>>>>
        | undefined;
    /**
     * Puts the first tab of a terminal kind in the active group, instead of a new group split off
     * to its right.
     */
    isNewSessionKindInActiveGroup?: boolean | undefined;
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
        };
    },
    init({inputs, updateState, host}) {
        const folderSessions = createFolderSessions({
            folder: inputs.folder,
            scope: inputs.scope,
        });
        updateState({
            folderSessions,
            ...startExtensionRuns({
                extensions: inputs.context.paneGroupExtensions,
                folder: inputs.folder,
                scope: inputs.scope,
                context: inputs.context,
                folderSessions,
                host,
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
    render({inputs, state, updateState, host}) {
        const {folderSessions} = state;
        if (!folderSessions) {
            return '';
        }
        const uiLayout = inputs.context.uiLayout;
        const info = inputs.context.folderData.value.folderInfo.get(inputs.folder);
        const isMobile = inputs.context.screenSize === ScreenSize.Mobile;
        const extensionInputs = inputs.extensionInputs || {};
        const sessions = folderSessions.value.sessions;
        const sessionError = folderSessions.value.error;

        folderSessions.sync({
            sessionStatuses: info?.sessionStatuses || [],
            watchSessionId: info?.watchMode.sessionId || '',
        });

        const folderNameBar = isMobile
            ? html`
                  <div class="folder-name-bar" ${tooltip(inputs.folder)}>
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

        const layoutKey = toPaneGroupKey({
            folder: inputs.folder,
            scope: inputs.scope,
        });
        const sharedLayout = uiLayout.value.layout?.tabLayouts[layoutKey];
        if (!sessions || !uiLayout.value.layout) {
            return html`
                ${folderNameBar} ${errorLine}
            `;
        }

        function writeLayout(change: (current: Readonly<TabLayout>) => Readonly<TabLayout>) {
            uiLayout.updateTabLayout({
                folder: layoutKey,
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
                    isNewKindInActiveGroup: inputs.isNewSessionKindInActiveGroup,
                });
            }, layout);
        }

        /** A stored layout the reducers can't trust is replaced, as if the folder had none. */
        const isSharedLayoutConsistent = sharedLayout
            ? isTabLayoutConsistent(sharedLayout)
            : undefined;
        const baseLayout = isSharedLayoutConsistent ? uiLayout.getTabLayout(layoutKey) : undefined;
        const unloadedPaneIds = inputs.context.panes
            .map((pane) => pane.id)
            .filter((paneId) => inputs.context.plugins.value.unloadedIds.includes(paneId));
        /** A pane's `defaultPlacement` is in its plugin's code, so a first layout waits on it. */
        if (!baseLayout && unloadedPaneIds.length) {
            inputs.context.plugins.requestContributions(unloadedPaneIds);
            return html`
                ${folderNameBar} ${errorLine}
            `;
        }
        const initialLayout =
            baseLayout ||
            uiLayout.takeShowRequests(layoutKey).reduce(
                (layout: Readonly<TabLayout>, kind) => showTabKind(layout, kind),
                inputs.defaultTabs
                    ? createTabLayout(
                          inputs.defaultTabs.map((groupTabs) => {
                              return groupTabs.map((tab) => {
                                  return {
                                      ...tab,
                                      id: createTabId(tab.kind),
                                  };
                              });
                          }),
                      )
                    : createDefaultTabLayout({
                          sessions,
                          panes: inputs.context.panes,
                          extensionInputs,
                      }),
            );
        if (!baseLayout) {
            if (isDebugLogEnabled()) {
                logDebug('paneGroup.render without base layout', {
                    folder: inputs.folder,
                    hasSharedLayout: !!sharedLayout,
                    isConsistent: isSharedLayoutConsistent,
                });
            }
            uiLayout.updateTabLayout({
                folder: layoutKey,
                update() {
                    return initialLayout;
                },
            });
        }
        const layout = syncAllSessionTabs(initialLayout);
        /** Traces tab selections that revert, while debug logging is on. */
        if (isDebugLogEnabled()) {
            const {selection} = splitTabLayout(layout);
            const renderedSelection = JSON.stringify(selection);
            if (loggedSelections.get(layoutKey) !== renderedSelection) {
                loggedSelections.set(layoutKey, renderedSelection);
                logDebug('paneGroup.render selection', {
                    folder: inputs.folder,
                    isActive: inputs.active,
                    selection,
                    windowSelection: uiLayout.value.selections[layoutKey],
                    serverSelection: uiLayout.value.layout.tabSelections[layoutKey],
                });
            }
        }
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

        /** A map keeps the last value for a key, so reverse both lists to keep their first matches. */
        const sessionTabsById = new Map<string, SessionTab>(
            getEnumValues(PaneKind).flatMap((kind) => {
                return sessions[kind].toReversed().map((session) => {
                    return [
                        toSessionTabId({
                            kind,
                            sessionId: session.id,
                        }),
                        {
                            kind,
                            session,
                        },
                    ];
                });
            }),
        );
        const statusByTabId = new Map<string, PaneStatus>(
            info?.sessionStatuses.toReversed().map(({kind, sessionId, status}) => {
                return [
                    toSessionTabId({
                        kind,
                        sessionId,
                    }),
                    status,
                ];
            }),
        );

        /** A plugin that loads after this pane group mounted brings its extension then. */
        const lateExtensions = inputs.context.paneGroupExtensions.filter((extension) => {
            return !Object.hasOwn(state.extensionRuns, extension.id);
        });
        const lateRuns = lateExtensions.length
            ? startExtensionRuns({
                  extensions: lateExtensions,
                  folder: inputs.folder,
                  scope: inputs.scope,
                  context: inputs.context,
                  folderSessions,
                  host,
              })
            : undefined;
        const extensionRuns = lateRuns
            ? {
                  ...state.extensionRuns,
                  ...lateRuns.extensionRuns,
              }
            : state.extensionRuns;
        if (lateRuns) {
            updateState({
                extensionRuns,
                extensionListeners: [
                    ...state.extensionListeners,
                    ...lateRuns.extensionListeners,
                ],
            });
        }

        const view: PaneGroupView = {
            folder: inputs.folder,
            scope: inputs.scope,
            context: inputs.context,
            isActive: inputs.active,
            isMobile,
            layout,
            extensionInputs,
            extensionRuns,
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
                (!findSessionPaneKind(tab.kind) || sessionTabsById.has(tabId))
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
                run: assertWrap.isDefined(extensionRuns[extension.id]),
                inputs: extensionInputs[extension.id],
                view,
                displayedTabIds,
                shownTabIds: state.shownTabIds,
                prUrl: info?.prUrl || undefined,
            });
        });

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
            await folderSessions?.reload();
            updateState({
                restartKeys: {
                    ...state.restartKeys,
                    [sessionId]: (state.restartKeys[sessionId] || 0) + 1,
                },
            });
        }

        async function openNewTab({kind, groupId, state: tabState, splitEdge}: NewTabRequest) {
            function placeTab(current: Readonly<TabLayout>, tab: Readonly<PaneTab>) {
                const targetGroup = groupId && current.groups[groupId];
                /**
                 * A new session's tab is usually placed already: the session list updates before
                 * `create` resolves, and `syncSessionTabs` puts it beside that kind's other tabs.
                 */
                const added =
                    current.tabs[tab.id] && groupId && targetGroup
                        ? moveTab(current, {
                              tabId: tab.id,
                              groupId,
                              index: targetGroup.tabIds.length,
                          })
                        : addTab(current, {
                              tab,
                              groupId,
                          });
                const addedGroupId = findTabGroupId(added, tab.id);
                return splitEdge && addedGroupId
                    ? splitTab(added, {
                          tabId: tab.id,
                          groupId: addedGroupId,
                          edge: splitEdge,
                      })
                    : added;
            }
            const paneKind = findSessionPaneKind(kind);
            if (!paneKind) {
                writeLayout((current) => {
                    return placeTab(current, {
                        id: createTabId(kind),
                        kind,
                        state: tabState && {
                            ...tabState,
                        },
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
                return placeTab(current, {
                    id: toSessionTabId({
                        kind: paneKind,
                        sessionId,
                    }),
                    kind,
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
        }: Readonly<{
            sessionTab: SessionTab;
            label: string;
        }>): ViraMenuItemEntry[] {
            return [
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
            const sessionTab = sessionTabsById.get(tab.id);
            if (sessionTab) {
                const label =
                    sessionTab.session.name ||
                    definition.label({
                        tabState,
                        context: inputs.context,
                    });
                const status = statusByTabId.get(tab.id) ?? PaneStatus.None;
                return {
                    label: html`
                        <${VirPaneTabLabel.assign({
                            label,
                            icon: definition.icon,
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
                        iconContent: definition.renderTabIcon?.({
                            tabState,
                            context: inputs.context,
                        }),
                        labelContent: tab.name
                            ? undefined
                            : definition.renderTabLabel?.({
                                  tabState,
                                  context: inputs.context,
                              }),
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
                    ...(definition.menuEntries?.({
                        tabState,
                        context: inputs.context,
                    }) || []),
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
                            })}></${VirPaneTabLabel}>
                        `,
                        kind: pane.id,
                        state: entry.state,
                    };
                });
            });
        const pendingPaneOptions = inputs.context.plugins.value.pendingPanes.map(
            (pane): TabHostNewTabOption => {
                return {
                    label: html`
                        <${VirPaneTabLabel.assign({
                            label: `${pane.label} (needs approval)`,
                            icon: createSizedIcon(LucideTriangleAlertIcon, 14),
                        })}
                            style=${css`
                                opacity: 0.6;
                            `}
                        ></${VirPaneTabLabel}>
                    `,
                    kind: pane.id,
                    state: undefined,
                    openInstead() {
                        inputs.context.openSettings({
                            section: SettingsSection.Plugins,
                        });
                    },
                };
            },
        );

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
                const sessionTab = sessionTabsById.get(tab.id);
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
                newTabOptions: [
                    ...newTabOptions,
                    ...pendingPaneOptions,
                ],
                isMobile,
            })}
                ${listen(VirTabHost.events.layoutChanged, (event) => {
                    if (isDebugLogEnabled()) {
                        logDebug('paneGroup.layoutChanged', {
                            folder: inputs.folder,
                            selection: splitTabLayout(event.detail).selection,
                        });
                    }
                    uiLayout.updateTabLayout({
                        folder: layoutKey,
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
        `;
    },
});
