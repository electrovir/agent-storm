import {buildPluginId} from '@agent-storm/common';
import {
    extractErrorMessage,
    getObjectTypedEntries,
    log,
    typedObjectFromEntries,
} from '@augment-vir/common';
import {hasErrorCode} from 'agent-storm-util';
import {rename} from 'node:fs/promises';
import {join} from 'node:path';
import {updateAppState} from './app-state.js';
import {pluginDataDir} from './file-paths.js';
import {renameSessionScopes} from './sessions.js';
import {updateSettings} from './settings.js';
import {changeAppLayout, loadUiLayout, renameFolderStateScopes} from './ui-layout.js';

/** The Build plugin's id from before it replaced the first Build plugin, which had the id `build`. */
const legacyBuildPluginId = 'build-v2';

/**
 * Matches the legacy id where an id, key, or scope names the plugin: alone, or before a `:` and the
 * rest of the id. Local storage style keys carry an `agent-storm:` prefix first.
 */
const legacyIdPattern = new RegExp(`^(agent-storm:)?${legacyBuildPluginId}(?=:|$)`);
const currentIdPattern = new RegExp(`^(agent-storm:)?${buildPluginId}(?=:|$)`);

function renameBuildId(id: string) {
    return id.replace(legacyIdPattern, `$1${buildPluginId}`);
}

/**
 * The entries with the legacy plugin id renamed to the current one. When there are any, entries
 * that already have the current id belong to the first Build plugin, so they're dropped. Undefined
 * when there's nothing to rename.
 */
function replaceLegacyEntries<Entry>({
    entries,
    readId,
    setId,
}: Readonly<{
    entries: ReadonlyArray<Entry>;
    readId(entry: Entry): string;
    setId(entry: Entry, id: string): Entry;
}>) {
    if (!entries.some((entry) => legacyIdPattern.test(readId(entry)))) {
        return undefined;
    }
    return entries
        .filter((entry) => !currentIdPattern.test(readId(entry)))
        .map((entry) => setId(entry, renameBuildId(readId(entry))));
}

export function replaceLegacyKeys<Value>(record: Readonly<Record<string, Value>> = {}) {
    const entries = replaceLegacyEntries<
        [
            string,
            Value,
        ]
    >({
        entries: getObjectTypedEntries(record),
        readId([key]) {
            return key;
        },
        setId(
            [
                ,
                value,
            ],
            key,
        ) {
            return [
                key,
                value,
            ];
        },
    });
    return entries && typedObjectFromEntries(entries);
}

function replaceLegacyTypeIds<Entry extends Readonly<{typeId: string}>>(
    entries: ReadonlyArray<Entry> = [],
) {
    return replaceLegacyEntries({
        entries,
        readId(entry) {
            return entry.typeId;
        },
        setId(entry, typeId) {
            return {
                ...entry,
                typeId,
            };
        },
    });
}

/**
 * Moves everything the app keeps under the Build plugin's legacy id, `build-v2`, to its current id.
 * Does nothing once nothing has the legacy id, so it's safe to run on every start. Must finish
 * before plugins start, since it moves the plugin's data folder.
 */
export async function migrateBuildPluginId() {
    await rename(
        join(pluginDataDir, legacyBuildPluginId),
        join(pluginDataDir, buildPluginId),
    ).catch((error: unknown) => {
        if (!hasErrorCode(error, 'ENOENT')) {
            log.warning(
                `Moving the Build plugin's data to ${join(pluginDataDir, buildPluginId)} failed, so it starts without its threads: ${extractErrorMessage(error)}`,
            );
        }
    });
    await updateSettings((settings) => {
        const pluginSettings = replaceLegacyKeys(settings.pluginSettings);
        const keyboardShortcuts = replaceLegacyKeys(settings.keyboardShortcuts);
        const notifications = replaceLegacyTypeIds(settings.notifications);
        const folderNotifications = replaceLegacyTypeIds(settings.folderNotifications);
        return pluginSettings || keyboardShortcuts || notifications || folderNotifications
            ? {
                  ...settings,
                  pluginSettings: pluginSettings || settings.pluginSettings,
                  keyboardShortcuts: keyboardShortcuts || settings.keyboardShortcuts,
                  notifications: notifications || settings.notifications,
                  folderNotifications: folderNotifications || settings.folderNotifications,
              }
            : undefined;
    });
    await updateAppState((state) => {
        const pluginDecisions = replaceLegacyEntries({
            entries: state.pluginDecisions || [],
            readId(decision) {
                return decision.pluginId;
            },
            setId(decision, pluginId) {
                return {
                    ...decision,
                    pluginId,
                };
            },
        });
        return pluginDecisions
            ? {
                  ...state,
                  pluginDecisions,
              }
            : undefined;
    });
    const uiLayout = await loadUiLayout();
    const mainTabOrder = replaceLegacyEntries({
        entries: uiLayout.mainTabOrder,
        readId(id) {
            return id;
        },
        setId(id, newId) {
            return newId;
        },
    });
    const enabledActivities = replaceLegacyKeys(uiLayout.enabledActivities);
    const rememberedSelections = replaceLegacyKeys(uiLayout.rememberedSelections);
    if (mainTabOrder || enabledActivities || rememberedSelections) {
        await changeAppLayout((existing) => {
            return {
                mainTabOrder: mainTabOrder || existing.mainTabOrder,
                enabledActivities: enabledActivities || existing.enabledActivities,
                rememberedSelections: rememberedSelections || existing.rememberedSelections,
            };
        });
    }
    await renameFolderStateScopes(renameBuildId);
    await renameSessionScopes(renameBuildId);
}
