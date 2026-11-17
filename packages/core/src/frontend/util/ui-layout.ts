import {
    activityBarSaveEndpoint,
    parsePaneGroupKey,
    rememberedSelectionSaveEndpoint,
    tabLayoutSaveEndpoint,
    uiLayoutEndpoint,
    type TabSelection,
    type UiLayout,
} from '@agent-storm/common';
import {check} from '@augment-vir/assert';
import {
    omitObjectKeys,
    PromiseQueue,
    removeDuplicates,
    type PartialWithUndefined,
} from '@augment-vir/common';
import {HttpMethod} from '@rest-vir/api';
import {Observable} from 'element-vir';
import {fetchApi} from './api-client.js';
import {logDebug} from './debug-log.js';
import {type FolderDataObservable} from './folder-data.js';
import {localStorageClient, type RememberedSelection} from './local-storage-client.js';
import {joinTabLayout, showTabKind, splitTabLayout, type TabLayout} from './tab-layout.js';

export type UiLayoutObservable = ReturnType<typeof createUiLayout>;

/**
 * The server's copy of the tab layouts and main tab order, so every window shows the same tabs in
 * the same places. Each window keeps its own selection, falling back to the folder's latest one
 * from any window. Changes apply here right away and save in the background; the server's revision,
 * polled with the folder list, pulls in changes made in other windows.
 */
export function createUiLayout(folderData: Readonly<Pick<FolderDataObservable, 'listen'>>) {
    const observable = new Observable<{
        /** Undefined until the first load answers. */
        layout: Readonly<UiLayout> | undefined;
        /** This window's selection in each folder it has changed one in. */
        selections: Readonly<Record<string, Readonly<TabSelection>>>;
    }>({
        defaultValue: {
            layout: undefined,
            selections: {},
        },
        /**
         * The default check calls any object it has already visited equal, and a new selection is
         * one object in both `layout.tabSelections` and `selections`, so a click matching the
         * server's selection was dropped.
         */
        equalityCheck: check.deepEquals,
    });
    const destroyObservable = observable.destroy.bind(observable);
    /** Saves go one at a time, so the server can't store an older layout after a newer one. */
    const writeQueue = new PromiseQueue();
    const tracking: {
        fetchedRevision: number | undefined;
        pendingWrites: number;
        writeGeneration: number;
        /**
         * Tabs asked for before their folder's layout exists, applied when the folder creates it.
         * Kept out of the observable since folders read them while rendering.
         */
        showRequests: Readonly<Record<string, string>>;
        /** Selections read from local storage, so rendering doesn't parse it again each time. */
        storedSelections: Readonly<Record<string, Readonly<TabSelection> | undefined>>;
    } = {
        fetchedRevision: undefined,
        pendingWrites: 0,
        writeGeneration: 0,
        showRequests: {},
        storedSelections: {},
    };

    /** Traces tab selections that revert, while debug logging is on. */
    function describeChangedFolders(
        previous: Readonly<UiLayout> | undefined,
        next: Readonly<UiLayout>,
    ) {
        return removeDuplicates([
            ...Object.keys(previous?.tabLayouts || {}),
            ...Object.keys(next.tabLayouts),
            ...Object.keys(next.tabSelections),
        ])
            .filter((folder) => {
                return (
                    !check.deepEquals(previous?.tabLayouts[folder], next.tabLayouts[folder]) ||
                    !check.deepEquals(previous?.tabSelections[folder], next.tabSelections[folder])
                );
            })
            .map((folder) => {
                return {
                    folder,
                    isSharedChanged: !check.deepEquals(
                        previous?.tabLayouts[folder],
                        next.tabLayouts[folder],
                    ),
                    groupIds: Object.keys(next.tabLayouts[folder]?.groups || {}),
                    previousServerSelection: previous?.tabSelections[folder],
                    serverSelection: next.tabSelections[folder],
                    windowSelection: observable.value.selections[folder],
                };
            });
    }

    function setLayout(layout: Readonly<UiLayout>, source: string) {
        if (!check.deepEquals(observable.value.layout, layout)) {
            logDebug('uiLayout.setLayout', {
                source,
                changedFolders: describeChangedFolders(observable.value.layout, layout),
            });
            observable.setValue({
                ...observable.value,
                layout,
            });
        }
    }

    function readSelection(folder: string) {
        const selection = observable.value.selections[folder];
        if (selection) {
            return selection;
        }
        if (!Object.hasOwn(tracking.storedSelections, folder)) {
            tracking.storedSelections = {
                ...tracking.storedSelections,
                [folder]: localStorageClient.tabSelectionByFolder.readFolder(folder),
            };
        }
        return tracking.storedSelections[folder];
    }

    async function load(revision: number) {
        tracking.fetchedRevision = revision;
        const generation = tracking.writeGeneration;
        try {
            const layout = await fetchApi(uiLayoutEndpoint, HttpMethod.Get);
            /** A save started since this load asked is newer than its answer. */
            const isApplied = generation === tracking.writeGeneration && !tracking.pendingWrites;
            logDebug('uiLayout.load', {
                revision,
                isApplied,
                pendingWrites: tracking.pendingWrites,
                isGenerationStale: generation !== tracking.writeGeneration,
            });
            if (isApplied) {
                setLayout(layout, `load revision ${revision}`);
            }
        } catch (error) {
            logDebug('uiLayout.load failed', {
                revision,
                error: String(error),
            });
            tracking.fetchedRevision = undefined;
            if (!observable.value.layout) {
                /** Leaves the panes usable with default layouts while the server can't answer. */
                setLayout(
                    {
                        tabLayouts: {},
                        tabSelections: {},
                        mainTabOrder: [],
                        enabledActivities: {},
                        rememberedSelections: {},
                    },
                    'load fallback',
                );
            }
        }
    }

    async function save(request: () => Promise<Readonly<UiLayout>>) {
        tracking.pendingWrites++;
        tracking.writeGeneration++;
        try {
            const saved = await writeQueue.add(request);
            tracking.pendingWrites--;
            logDebug('uiLayout.save', {
                isApplied: !tracking.pendingWrites,
                pendingWrites: tracking.pendingWrites,
            });
            if (!tracking.pendingWrites) {
                setLayout(saved, 'save');
            }
        } catch (error) {
            logDebug('uiLayout.save failed', {
                error: String(error),
            });
            tracking.pendingWrites--;
            /** Reloads on the next poll, putting back whatever the server kept. */
            tracking.fetchedRevision = undefined;
        }
    }

    const removeListener = folderData.listen(true, ({live}) => {
        const revision = live?.listing.uiLayoutRevision;
        if (revision != undefined && revision !== tracking.fetchedRevision) {
            void load(revision);
        }
    });

    /** `folder`'s layout with this window's selection. Undefined until the folder has one. */
    function getTabLayout(folder: string) {
        const layout = observable.value.layout;
        const shared = layout?.tabLayouts[folder];
        return (
            shared &&
            joinTabLayout(shared, [
                readSelection(folder),
                layout.tabSelections[folder],
            ])
        );
    }

    function updateTabLayout({
        folder,
        update,
    }: Readonly<{
        folder: string;
        /** Returning undefined or an unchanged layout saves nothing. */
        update: (current: Readonly<TabLayout> | undefined) => Readonly<TabLayout> | undefined;
    }>) {
        const current = observable.value.layout;
        const existing = getTabLayout(folder);
        const updated = current && update(existing);
        if (!current || !updated) {
            logDebug('uiLayout.updateTabLayout skipped', {
                folder,
                hasLayout: !!current,
                caller: new Error('caller').stack?.split('\n').slice(2, 6),
            });
            return;
        }
        const {shared, selection} = splitTabLayout(updated);
        const isSharedChanged = !check.deepEquals(current.tabLayouts[folder], shared);
        /**
         * Compared with what's shown rather than with this window's own selection, so a window
         * following the folder's latest selection keeps following it through layout changes.
         */
        const isSelectionChanged = !check.deepEquals(
            existing && splitTabLayout(existing).selection,
            selection,
        );
        if (!isSharedChanged && !isSelectionChanged) {
            return;
        }
        logDebug('uiLayout.updateTabLayout', {
            folder,
            isSharedChanged,
            isSelectionChanged,
            existingSelection: existing && splitTabLayout(existing).selection,
            selection,
            caller: new Error('caller').stack?.split('\n').slice(2, 6),
        });
        if (isSelectionChanged) {
            localStorageClient.tabSelectionByFolder.writeFolder({
                folder,
                value: selection,
            });
        }
        observable.setValue({
            layout: {
                ...current,
                tabLayouts: {
                    ...current.tabLayouts,
                    [folder]: shared,
                },
                tabSelections: isSelectionChanged
                    ? {
                          ...current.tabSelections,
                          [folder]: selection,
                      }
                    : current.tabSelections,
            },
            selections: isSelectionChanged
                ? {
                      ...observable.value.selections,
                      [folder]: selection,
                  }
                : observable.value.selections,
        });
        const joinedAfter = getTabLayout(folder);
        logDebug('uiLayout.updateTabLayout applied', {
            folder,
            windowSelection: observable.value.selections[folder],
            serverSelection: observable.value.layout?.tabSelections[folder],
            joinedSelection: joinedAfter && splitTabLayout(joinedAfter).selection,
            sharedGroups: observable.value.layout?.tabLayouts[folder]?.groups,
            sharedRootId: observable.value.layout?.tabLayouts[folder]?.rootId,
        });
        void save(() => {
            return fetchApi(tabLayoutSaveEndpoint, HttpMethod.Put, {
                requestData: {
                    ...parsePaneGroupKey(folder),
                    layout: isSharedChanged ? shared : undefined,
                    selection: isSelectionChanged ? selection : undefined,
                },
            });
        });
    }

    return Object.assign(observable, {
        getTabLayout,
        updateTabLayout,
        /** Saves whichever of the vertical tab bar's order and the enabled activities is given. */
        setActivityBar({
            order,
            enabledActivities,
        }: Readonly<
            PartialWithUndefined<{
                order: ReadonlyArray<string>;
                enabledActivities: Readonly<Record<string, boolean>>;
            }>
        >) {
            const current = observable.value.layout;
            if (!current) {
                return;
            }
            const next = {
                ...current,
                mainTabOrder: [
                    ...(order || current.mainTabOrder),
                ],
                enabledActivities: {
                    ...(enabledActivities || current.enabledActivities),
                },
            };
            if (
                check.deepEquals(next.mainTabOrder, current.mainTabOrder) &&
                check.deepEquals(next.enabledActivities, current.enabledActivities)
            ) {
                return;
            }
            setLayout(next, 'setActivityBar');
            void save(() => {
                return fetchApi(activityBarSaveEndpoint, HttpMethod.Put, {
                    requestData: {
                        order: order
                            ? [
                                  ...order,
                              ]
                            : undefined,
                        enabledActivities: enabledActivities
                            ? {
                                  ...enabledActivities,
                              }
                            : undefined,
                    },
                });
            });
        },
        /**
         * `memory`'s remembered values, most specific first: this window's, this browser's latest,
         * then the server's. The caller uses the first one that still exists.
         */
        readRemembered(memory: Readonly<RememberedSelection>) {
            return [
                memory.window.read(),
                memory.browser.read(),
                observable.value.layout?.rememberedSelections[memory.key],
            ].filter(check.isTruthy);
        },
        /** Remembers `value` at every level of `memory`. `undefined` forgets it at every level. */
        rememberSelection({
            memory,
            value,
        }: Readonly<{
            memory: Readonly<RememberedSelection>;
            value: string | undefined;
        }>) {
            memory.window.write(value);
            memory.browser.write(value);
            const current = observable.value.layout;
            if (current?.rememberedSelections[memory.key] === value) {
                return;
            }
            if (current) {
                setLayout(
                    {
                        ...current,
                        rememberedSelections: value
                            ? {
                                  ...current.rememberedSelections,
                                  [memory.key]: value,
                              }
                            : omitObjectKeys(current.rememberedSelections, [
                                  memory.key,
                              ]),
                    },
                    'rememberSelection',
                );
            }
            void save(() => {
                return fetchApi(rememberedSelectionSaveEndpoint, HttpMethod.Put, {
                    requestData: {
                        key: memory.key,
                        value: value || '',
                    },
                });
            });
        },
        /**
         * Shows a tab of `kind` in a folder's layout (see {@link showTabKind}), or once the folder
         * creates its layout when it has none yet.
         */
        showPaneTab({
            folder,
            kind,
        }: Readonly<{
            folder: string;
            kind: string;
        }>) {
            if (observable.value.layout?.tabLayouts[folder]) {
                updateTabLayout({
                    folder,
                    update(current) {
                        return current && showTabKind(current, kind);
                    },
                });
            } else {
                tracking.showRequests = {
                    ...tracking.showRequests,
                    [folder]: kind,
                };
            }
        },
        /** The tab asked for by `showPaneTab` before `folder`'s layout existed, cleared on read. */
        takeShowRequest(folder: string) {
            const kind = tracking.showRequests[folder];
            tracking.showRequests = omitObjectKeys(tracking.showRequests, [
                folder,
            ]);
            return kind;
        },
        destroy() {
            removeListener();
            destroyObservable();
        },
    });
}
