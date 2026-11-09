import {
    defaultSettings,
    settingsShape,
    type AiDefinition,
    type FolderSettings,
    type Settings,
} from '@agent-storm/common';
import {check} from '@augment-vir/assert';
import {
    extractExtension,
    getObjectTypedEntries,
    log,
    mapObjectValues,
    PromiseQueue,
    removeDuplicates,
    typedObjectFromEntries,
    type UnknownObject,
} from '@augment-vir/common';
import {findConfigFile, parseConfigContents} from 'config-vir';
import {mkdir, rename, stat} from 'node:fs/promises';
import {join} from 'node:path';
import {assertValidShape} from 'object-shape-tester';
import {pruneAiAvatars} from './ai-avatar.js';
import {configBackupDir, settingsJsonPath, userDataDir} from './file-paths.js';
import {normalizePath} from './paths.js';
import {writeFileAtomically} from './write-file-atomically.js';

/**
 * The user's settings file, whichever format it's in. Undefined when there's none, and throws when
 * there's more than one.
 */
export async function findSettingsPath() {
    return await findConfigFile({
        directory: userDataDir,
        baseName: 'settings',
    });
}

/**
 * Fills in every default `saved` leaves out, recursing into nested objects so a file that sets one
 * forge setting still gets the rest. Arrays are taken whole. Annotated because it's recursive.
 */
export function withSettingsDefaults({
    defaults,
    saved,
}: Readonly<{defaults: Readonly<UnknownObject>; saved: Readonly<UnknownObject>}>): UnknownObject {
    return mapObjectValues(
        {
            ...defaults,
            ...saved,
        },
        (key, value) => {
            const defaultValue = defaults[key];
            return check.isObject(defaultValue) && check.isObject(value)
                ? withSettingsDefaults({
                      defaults: defaultValue,
                      saved: value,
                  })
                : value;
        },
    );
}

/**
 * Drops every value equal to its default, and every object left empty, so the saved file holds only
 * what the user chose and a later default change still reaches them. Annotated because it's
 * recursive.
 */
export function stripSettingsDefaults({
    defaults,
    settings,
}: Readonly<{
    defaults: Readonly<UnknownObject>;
    settings: Readonly<UnknownObject>;
}>): UnknownObject {
    return typedObjectFromEntries(
        getObjectTypedEntries(settings).flatMap(
            ([
                key,
                value,
            ]) => {
                const defaultValue = defaults[key];
                if (check.deepEquals(value, defaultValue)) {
                    return [];
                } else if (!check.isObject(defaultValue) || !check.isObject(value)) {
                    return [
                        [
                            key,
                            value,
                        ],
                    ];
                }
                const stripped = stripSettingsDefaults({
                    defaults: defaultValue,
                    settings: value,
                });
                return Object.keys(stripped).length
                    ? [
                          [
                              key,
                              stripped,
                          ],
                      ]
                    : [];
            },
        ),
    );
}

function normalizeSettings(settings: Readonly<Settings>): Settings {
    const definitionIds = settings.aiDefinitions.map((definition) => definition.id);
    return {
        ...settings,
        /**
         * Overrides aren't checked against the user's AIs: one may name an AI that only a folder's
         * settings file defines. A dangling one falls through to the folder's inherited AI.
         */
        folderAiIds: settings.folderAiIds.map((entry) => {
            return {
                ...entry,
                folder: normalizePath(entry.folder),
            };
        }),
        folderPostWorktreeCmds: settings.folderPostWorktreeCmds
            .filter((entry) => entry.postWorktreeCmd.trim())
            .map((entry) => {
                return {
                    ...entry,
                    folder: normalizePath(entry.folder),
                };
            }),
        /** A dangling default resolves to the first definition. */
        defaultAiId: definitionIds.includes(settings.defaultAiId) ? settings.defaultAiId : '',
    };
}

/**
 * The user's AIs followed by those of each folder settings file, nearest first. The first
 * definition of an id wins, so a folder file can't replace one of the user's.
 */
export function combineAiDefinitions({
    settings,
    folderLayers,
}: Readonly<{
    settings: Readonly<Settings>;
    folderLayers: ReadonlyArray<Readonly<FolderSettings>>;
}>) {
    return removeDuplicates(
        [
            ...settings.aiDefinitions,
            ...folderLayers.flatMap((layer) => layer.aiDefinitions || []),
        ],
        (definition) => definition.id,
    );
}

export function findAiDefinition({
    aiDefinitions,
    aiId,
}: Readonly<{
    aiDefinitions: ReadonlyArray<AiDefinition>;
    aiId: string | undefined;
}>) {
    return aiId ? aiDefinitions.find((definition) => definition.id === aiId) : undefined;
}

/**
 * The AI a folder resolves to, and the one it would without its own override. Walks the folder's
 * own override, then each fallback folder's (a worktree's root repo), then each folder settings
 * file's `defaultAiId`, then the user's `defaultAiId`, then the first defined AI. Both are
 * undefined only when no AI is defined at all, which the callers treat as "nothing to spawn".
 */
export function resolveFolderAi({
    settings,
    folderLayers,
    folder,
    fallbackFolders = [],
}: Readonly<{
    settings: Readonly<Settings>;
    folderLayers: ReadonlyArray<Readonly<FolderSettings>>;
    folder: string;
    fallbackFolders?: ReadonlyArray<string> | undefined;
}>) {
    const aiDefinitions = combineAiDefinitions({
        settings,
        folderLayers,
    });
    function findOverride(candidate: string) {
        return findAiDefinition({
            aiDefinitions,
            aiId: settings.folderAiIds.find((entry) => entry.folder === normalizePath(candidate))
                ?.aiId,
        });
    }
    const inheritedAi =
        fallbackFolders.map(findOverride).find(check.isTruthy) ||
        folderLayers
            .map((layer) => {
                return findAiDefinition({
                    aiDefinitions,
                    aiId: layer.defaultAiId,
                });
            })
            .find(check.isTruthy) ||
        findAiDefinition({
            aiDefinitions,
            aiId: settings.defaultAiId,
        }) ||
        aiDefinitions[0];
    return {
        ai: findOverride(folder) || inheritedAi,
        inheritedAi,
        aiDefinitions,
    };
}

/**
 * Point one folder at an AI, or clear its override with an empty `aiId`. Writing the id the folder
 * would inherit anyway still records an override — the user picked that AI explicitly, and it
 * should survive a later change to the default.
 */
export function setFolderAiId({
    settings,
    folder,
    aiId,
}: Readonly<{
    settings: Readonly<Settings>;
    folder: string;
    aiId: string;
}>): Settings {
    const normalizedFolder = normalizePath(folder);
    const otherFolders = settings.folderAiIds.filter((entry) => entry.folder !== normalizedFolder);
    return normalizeSettings({
        ...settings,
        folderAiIds: aiId
            ? [
                  ...otherFolders,
                  {
                      folder: normalizedFolder,
                      aiId,
                  },
              ]
            : otherFolders,
    });
}

/**
 * Stands in whenever the settings define no AI, so the AI pane always has something to spawn. Its
 * id is fixed rather than generated because the stand-in isn't saved until the next save, and an
 * override written against one load has to match the next.
 */
const fallbackAiDefinition: AiDefinition = {
    id: 'default-claude',
    name: 'Claude',
    resumeSessionCommand: 'claude',
    newSessionCommand: '',
};

export function withFallbackAi(settings: Readonly<Settings>): Settings {
    return settings.aiDefinitions.length
        ? settings
        : {
              ...settings,
              aiDefinitions: [
                  fallbackAiDefinition,
              ],
              defaultAiId: fallbackAiDefinition.id,
          };
}

/** Changes whenever the settings file does. 0 while there's no settings file. */
export async function readSettingsRevision() {
    const settingsPath = await findSettingsPath().catch(() => undefined);
    return (settingsPath && (await stat(settingsPath).catch(() => undefined))?.mtimeMs) || 0;
}

/**
 * Validates raw settings, as read from a file, and fills in their defaults. Throws when they don't
 * match {@link settingsShape}.
 */
export function parseSettings({
    rawSettings,
    source,
}: Readonly<{
    rawSettings: Readonly<UnknownObject>;
    source: string;
}>): Settings {
    const merged = withSettingsDefaults({
        defaults: defaultSettings,
        saved: rawSettings,
    });
    assertValidShape(merged, settingsShape, {}, `Settings from ${source} are invalid.`);
    return normalizeSettings(withFallbackAi(merged));
}

/**
 * A missing file is the defaults. Any other failure (a read error, unparsable contents, contents
 * that don't match {@link settingsShape}, two settings files) throws, and load-modify-save callers
 * catch it and skip their save so the existing file is preserved.
 */
export async function loadSettings(): Promise<Settings> {
    const settingsPath = await findSettingsPath();
    if (!settingsPath) {
        return withFallbackAi(defaultSettings);
    }
    return parseSettings({
        rawSettings: await parseConfigContents({
            configPath: settingsPath,
        }),
        source: settingsPath,
    });
}

/**
 * Always writes `settings.json`, atomically: a non-atomic write leaves a brief empty-file window,
 * and a concurrent {@link loadSettings} that reads it would throw instead of seeing the previous
 * settings. A settings file in another format is moved into the backups once the JSON one exists.
 */
async function writeSettings(settings: Readonly<Settings>): Promise<void> {
    const normalized = normalizeSettings(settings);
    try {
        const existingPath = await findSettingsPath().catch(() => undefined);
        await writeFileAtomically({
            path: settingsJsonPath,
            contents: JSON.stringify(
                stripSettingsDefaults({
                    defaults: defaultSettings,
                    settings: normalized,
                }),
                undefined,
                4,
            ),
        });
        if (existingPath && existingPath !== settingsJsonPath) {
            await mkdir(configBackupDir, {
                recursive: true,
            });
            const backupPath = join(
                configBackupDir,
                `settings-replaced-${Date.now()}${extractExtension(existingPath).extension}`,
            );
            await rename(existingPath, backupPath);
            log.info(
                `Converted ${existingPath} to ${settingsJsonPath}. The original is now at ${backupPath}.`,
            );
        }
        /** Replacing or deleting an AI's avatar leaves its old file behind; this is the cleanup. */
        await pruneAiAvatars(normalized.aiDefinitions);
    } catch (error) {
        log.warning(`Failed to save settings: ${String(error)}`);
        throw error;
    }
}

/**
 * Serializes every settings write. Without it, two requests that each load, modify, and save the
 * settings interleave and the later save silently drops the earlier one's change.
 */
const settingsWriteQueue = new PromiseQueue();

/** Replaces the user's settings. Runs after any queued {@link updateSettings} calls finish. */
export async function saveSettings(settings: Readonly<Settings>): Promise<void> {
    await settingsWriteQueue.add(async () => await writeSettings(settings));
}

/**
 * Load, modify, and save the settings as one queued step so concurrent updates can't overwrite each
 * other. Skips the write when `update` returns `undefined` or when the current settings can't be
 * read, so a transient read failure never resets the user's settings to defaults.
 */
export async function updateSettings(
    update: (settings: Readonly<Settings>) => Settings | undefined,
): Promise<void> {
    await settingsWriteQueue.add(async () => {
        const settings = await loadSettings().catch(() => undefined);
        const updated = settings && update(settings);
        if (updated) {
            await writeSettings(updated);
        }
    });
}
