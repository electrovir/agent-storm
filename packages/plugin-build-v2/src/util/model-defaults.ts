import {settingsEndpoint} from '@agent-storm/common';
import {fetchApi, type AppContext} from '@agent-storm/core/frontend';
import {omitObjectKeys} from '@augment-vir/common';
import {HttpMethod} from '@rest-vir/api';
import {
    readModelDefaults,
    writeModelDefaults,
    type ModelDefault,
    type ModelDefaults,
} from './model-default-settings.js';

/** The folder whose default applies to `path`: its repo, for a worktree. */
export function findModelDefaultsFolder({
    context,
    path,
}: Readonly<{
    context: Pick<AppContext, 'folderData'>;
    path: string;
}>) {
    return context.folderData.value.folderInfo.get(path)?.parentRepoPath || path;
}

/** The folder's default, else the global one. */
export function resolveModelDefault({
    context,
    folder,
}: Readonly<{
    context: Pick<AppContext, 'folderData'>;
    folder: string;
}>) {
    const defaults = readModelDefaults(
        (context.folderData.value.live || context.folderData.value.snapshot)?.settings,
    );
    return defaults.folders[folder] || defaults.global || undefined;
}

function isSameModelDefault({
    first,
    second,
}: Readonly<{
    first: Readonly<ModelDefault> | null | undefined;
    second: Readonly<ModelDefault> | null | undefined;
}>) {
    if (!first || !second) {
        return !first && !second;
    }
    return (
        first.provider === second.provider &&
        first.model === second.model &&
        (first.effort || undefined) === (second.effort || undefined)
    );
}

/**
 * Makes `modelDefault` the folder's default, or clears the folder's default when `modelDefault`
 * matches the global one. Sets the global default too when it isn't set yet.
 */
export async function saveFolderModelDefault({
    context,
    folder,
    modelDefault,
}: Readonly<{
    context: Pick<AppContext, 'folderData'>;
    folder: string;
    modelDefault: Readonly<ModelDefault>;
}>) {
    function applyDefault(defaults: Readonly<ModelDefaults>): ModelDefaults {
        const global = defaults.global || modelDefault;
        return {
            global,
            folders: isSameModelDefault({
                first: global,
                second: modelDefault,
            })
                ? omitObjectKeys(defaults.folders, [
                      folder,
                  ])
                : {
                      ...defaults.folders,
                      [folder]: modelDefault,
                  },
        };
    }

    function isChanged(defaults: Readonly<ModelDefaults>) {
        const updated = applyDefault(defaults);
        return (
            !isSameModelDefault({
                first: updated.global,
                second: defaults.global,
            }) ||
            !isSameModelDefault({
                first: updated.folders[folder],
                second: defaults.folders[folder],
            })
        );
    }

    if (
        !isChanged(
            readModelDefaults(
                (context.folderData.value.live || context.folderData.value.snapshot)?.settings,
            ),
        )
    ) {
        return;
    }
    const settings = await fetchApi(settingsEndpoint, HttpMethod.Get);
    const defaults = readModelDefaults(settings);
    if (!isChanged(defaults)) {
        return;
    }
    await fetchApi(settingsEndpoint, HttpMethod.Put, {
        requestData: writeModelDefaults({
            settings,
            defaults: applyDefault(defaults),
        }),
    });
}

/**
 * Makes `modelDefault` the global default and the folder's, wherever one isn't set yet. A default
 * saved without an effort counts as not set once `modelDefault` has one.
 */
export async function fillMissingModelDefaults({
    context,
    folder,
    modelDefault,
}: Readonly<{
    context: Pick<AppContext, 'folderData'>;
    folder: string;
    modelDefault: Readonly<ModelDefault>;
}>) {
    function pickDefault(existing: Readonly<ModelDefault> | null | undefined) {
        return existing && (existing.effort || !modelDefault.effort) ? existing : modelDefault;
    }

    function isMissing(defaults: Readonly<ModelDefaults>) {
        return (
            pickDefault(defaults.global) !== defaults.global ||
            pickDefault(defaults.folders[folder]) !== defaults.folders[folder]
        );
    }

    if (
        !isMissing(
            readModelDefaults(
                (context.folderData.value.live || context.folderData.value.snapshot)?.settings,
            ),
        )
    ) {
        return;
    }
    const settings = await fetchApi(settingsEndpoint, HttpMethod.Get);
    const defaults = readModelDefaults(settings);
    if (!isMissing(defaults)) {
        return;
    }
    await fetchApi(settingsEndpoint, HttpMethod.Put, {
        requestData: writeModelDefaults({
            settings,
            defaults: {
                global: pickDefault(defaults.global),
                folders: {
                    ...defaults.folders,
                    [folder]: pickDefault(defaults.folders[folder]),
                },
            },
        }),
    });
}
