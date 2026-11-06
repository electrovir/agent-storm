import {
    configEndpoint,
    foldersEndpoint,
    updateCheckEndpoint,
    type Config,
    type FolderInfo,
    type UpdateStatus,
} from '@agent-storm/common';
import {check} from '@augment-vir/assert';
import {extractErrorMessage, type PartialWithUndefined} from '@augment-vir/common';
import {HttpMethod} from '@rest-vir/api';
import {convertDuration, type AnyDuration} from 'date-vir';
import {Observable} from 'element-vir';
import {fetchApi} from './api-client.js';
import {localStorageClient, type SidebarSnapshot} from './local-storage-client.js';

export type FolderData = PartialWithUndefined<{
    /** The server's answers from this page load. */
    live: {
        listing: Awaited<
            ReturnType<typeof fetchApi<typeof foldersEndpoint, typeof HttpMethod.Get>>
        >;
        config: Config;
        /** Undefined when the update check itself failed. */
        updateStatus: UpdateStatus | undefined;
    };
    /**
     * The last answer from any page load, stored in localStorage rather than IndexedDB because
     * localStorage reads synchronously, so the sidebars paint their lists on the very first frame.
     */
    snapshot: SidebarSnapshot;
    loadError: string;
}> & {
    /** This page load's folder list by absolute path, so empty until the first poll answers. */
    folderInfo: ReadonlyMap<string, FolderInfo>;
};

export type FolderDataObservable = ReturnType<typeof createFolderData>;

/** The server re-checks for updates on its own schedule, so asking more often finds nothing new. */
const updateCheckInterval: AnyDuration = {
    minutes: 5,
};

/**
 * Polls the server's folder list, config, and update status for the whole app, so every sidebar and
 * `vir-app` share one set of requests. The config is only fetched again when the folder list
 * reports a new revision, and the update status on its own slower schedule. Every poll notifies
 * listeners, even when nothing changed, which is what clears a sidebar's action error on the next
 * poll.
 */
export function createFolderData() {
    const observable = new Observable<FolderData>({
        equalityCheck: undefined,
        defaultValue: {
            snapshot: localStorageClient.sidebarSnapshot.read(),
            folderInfo: new Map(),
        },
    });
    const destroyObservable = observable.destroy.bind(observable);
    const fetched: {
        config: Config | undefined;
        configRevision: number;
        updateStatus: UpdateStatus | undefined;
        updateCheckedAtMs: number;
    } = {
        config: undefined,
        configRevision: 0,
        updateStatus: undefined,
        updateCheckedAtMs: 0,
    };

    async function fetchUpdateStatus() {
        if (
            Date.now() - fetched.updateCheckedAtMs <
            convertDuration(updateCheckInterval, {
                milliseconds: true,
            }).milliseconds
        ) {
            return fetched.updateStatus;
        }
        fetched.updateCheckedAtMs = Date.now();
        fetched.updateStatus = await fetchApi(updateCheckEndpoint, HttpMethod.Get).catch(
            () => undefined,
        );
        return fetched.updateStatus;
    }

    async function refresh() {
        try {
            const [
                listing,
                updateStatus,
            ] = await Promise.all([
                fetchApi(foldersEndpoint, HttpMethod.Get),
                fetchUpdateStatus(),
            ]);
            /**
             * Fetched after the listing, so a change landing in between shows up as a newer
             * revision next poll.
             */
            const config =
                fetched.config && fetched.configRevision === listing.configRevision
                    ? fetched.config
                    : await fetchApi(configEndpoint, HttpMethod.Get);
            fetched.config = config;
            fetched.configRevision = listing.configRevision;
            const snapshot = {
                folders: listing.folders,
                config,
            };
            if (!check.deepEquals(observable.value.snapshot, snapshot)) {
                localStorageClient.sidebarSnapshot.write(snapshot);
            }
            observable.setValue({
                live: {
                    listing,
                    config,
                    updateStatus,
                },
                snapshot,
                folderInfo: new Map(
                    listing.folders.map((folder) => {
                        return [
                            folder.path,
                            folder,
                        ];
                    }),
                ),
            });
        } catch (error) {
            observable.setValue({
                ...observable.value,
                loadError: extractErrorMessage(error),
            });
        }
    }

    void refresh();
    const pollHandle = setInterval(
        () => {
            void refresh();
        },
        convertDuration(
            {
                seconds: 2,
            },
            {
                milliseconds: true,
            },
        ).milliseconds,
    );

    return Object.assign(observable, {
        refresh,
        /** Drops folders from `folderInfo` right away, rather than waiting for the next poll. */
        removeFolders(folderPaths: ReadonlyArray<string>) {
            observable.setValue({
                ...observable.value,
                folderInfo: new Map(
                    [...observable.value.folderInfo].filter(([folderPath]) => {
                        return !folderPaths.includes(folderPath);
                    }),
                ),
            });
        },
        destroy() {
            clearInterval(pollHandle);
            destroyObservable();
        },
    });
}
