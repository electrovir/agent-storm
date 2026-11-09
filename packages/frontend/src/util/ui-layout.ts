import {
    activityBarSaveEndpoint,
    tabLayoutSaveEndpoint,
    uiLayoutEndpoint,
    type PaneTabKind,
    type TabSelection,
    type UiLayout,
} from '@agent-storm/common';
import {check} from '@augment-vir/assert';
import {omitObjectKeys, PromiseQueue, type PartialWithUndefined} from '@augment-vir/common';
import {HttpMethod} from '@rest-vir/api';
import {Observable} from 'element-vir';
import {fetchApi} from './api-client.js';
import {type FolderDataObservable} from './folder-data.js';
import {localStorageClient} from './local-storage-client.js';
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
        showRequests: Readonly<Record<string, PaneTabKind>>;
        /** Selections read from local storage, so rendering doesn't parse it again each time. */
        storedSelections: Readonly<Record<string, Readonly<TabSelection> | undefined>>;
    } = {
        fetchedRevision: undefined,
        pendingWrites: 0,
        writeGeneration: 0,
        showRequests: {},
        storedSelections: {},
    };

    function setLayout(layout: Readonly<UiLayout>) {
        if (!check.deepEquals(observable.value.layout, layout)) {
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
            if (generation === tracking.writeGeneration && !tracking.pendingWrites) {
                setLayout(layout);
            }
        } catch {
            tracking.fetchedRevision = undefined;
            if (!observable.value.layout) {
                /** Leaves the panes usable with default layouts while the server can't answer. */
                setLayout({
                    tabLayouts: {},
                    tabSelections: {},
                    mainTabOrder: [],
                    enabledActivities: {},
                });
            }
        }
    }

    async function save(request: () => Promise<Readonly<UiLayout>>) {
        tracking.pendingWrites++;
        tracking.writeGeneration++;
        try {
            const saved = await writeQueue.add(request);
            tracking.pendingWrites--;
            if (!tracking.pendingWrites) {
                setLayout(saved);
            }
        } catch {
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
        void save(() => {
            return fetchApi(tabLayoutSaveEndpoint, HttpMethod.Put, {
                requestData: {
                    folder,
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
            setLayout(next);
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
         * Shows a tab of `kind` in a folder's layout (see {@link showTabKind}), or once the folder
         * creates its layout when it has none yet.
         */
        showPaneTab({
            folder,
            kind,
        }: Readonly<{
            folder: string;
            kind: PaneTabKind;
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
