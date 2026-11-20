import {type FolderInfo, type PrStatus} from '@agent-storm/common';
import {type PluginFolderHooks} from '@agent-storm/core/server';
import {getObjectTypedValues, omitObjectKeys} from '@augment-vir/common';

/**
 * Each running plugin server's folder hooks, by plugin id. Kept apart from `plugin-servers.ts` so
 * folder info can read it without importing the plugin loader.
 */
const pluginFolderHooks: {
    byPluginId: Readonly<Record<string, PluginFolderHooks>>;
} = {
    byPluginId: {},
};

/** Sets the plugin's folder hooks, or removes them when `hooks` is undefined. */
export function setPluginFolderHooks({
    pluginId,
    hooks,
}: Readonly<{
    pluginId: string;
    hooks: PluginFolderHooks | undefined;
}>) {
    const others = omitObjectKeys(pluginFolderHooks.byPluginId, [
        pluginId,
    ]);
    pluginFolderHooks.byPluginId = hooks
        ? {
              ...others,
              [pluginId]: hooks,
          }
        : others;
}

/** The branch's PR status after every running plugin's `overridePrStatus`, in turn. */
export async function applyPluginPrStatusOverrides({
    prStatus,
    ...branch
}: Readonly<{
    prStatus: PrStatus;
    owner: string;
    repoName: string;
    branchName: string;
}>) {
    return await getObjectTypedValues(pluginFolderHooks.byPluginId).reduce(
        async (previous, hooks) => {
            const current = await previous;
            return hooks.overridePrStatus
                ? await hooks.overridePrStatus({
                      ...branch,
                      prStatus: current,
                  })
                : current;
        },
        Promise.resolve(prStatus),
    );
}

/** Whether any running plugin's `isFolderBusy` is true for the folder. */
export async function isFolderBusyInPlugins(folder: string) {
    return (
        await Promise.all(
            getObjectTypedValues(pluginFolderHooks.byPluginId).map(async (hooks) => {
                return !!(await hooks.isFolderBusy?.(folder));
            }),
        )
    ).some(Boolean);
}

/** The first running plugin's answer for the folder's watch mode, or `fallback` when none has one. */
export function readPluginWatchMode({
    folder,
    fallback,
}: Readonly<{
    folder: string;
    fallback: FolderInfo['watchMode'];
}>) {
    return (
        getObjectTypedValues(pluginFolderHooks.byPluginId)
            .map((hooks) => hooks.readWatchMode?.(folder))
            .find((watchMode) => watchMode != undefined) || fallback
    );
}
