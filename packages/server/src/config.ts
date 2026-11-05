import {configShape, defaultConfig, type AiDefinition, type Config} from '@agent-storm/common';
import {log, PromiseQueue} from '@augment-vir/common';
import {readFile, stat} from 'node:fs/promises';
import {assertValidShape} from 'object-shape-tester';
import {pruneAiAvatars} from './ai-avatar.js';
import {configPath} from './file-paths.js';
import {normalizePath} from './paths.js';
import {writeFileAtomically} from './write-file-atomically.js';

function normalizeConfig(config: Readonly<Config>): Config {
    const definitionIds = config.aiDefinitions.map((definition) => definition.id);
    return {
        ...config,
        repos: config.repos.map((repo) => {
            return {
                ...repo,
                path: normalizePath(repo.path),
            };
        }),
        /**
         * Drop overrides pointing at a definition that no longer exists, so deleting an AI can't
         * leave folders resolving to nothing. Those folders fall back to the default instead.
         */
        folderAiIds: config.folderAiIds
            .filter((entry) => definitionIds.includes(entry.aiId))
            .map((entry) => {
                return {
                    ...entry,
                    folder: normalizePath(entry.folder),
                };
            }),
        /** Same reasoning as `folderAiIds`: a dangling default resolves to the first definition. */
        defaultAiId: definitionIds.includes(config.defaultAiId) ? config.defaultAiId : '',
    };
}

/**
 * The AI a folder resolves to, walking its own override, then each fallback folder's (a worktree's
 * root repo), then `defaultAiId`, then the first defined AI. Undefined only when the user has
 * defined no AI at all, which the callers treat as "nothing to spawn".
 */
export function getFolderAiDefinition({
    config,
    folder,
    fallbackFolders = [],
}: Readonly<{
    config: Config;
    folder: string;
    fallbackFolders?: ReadonlyArray<string> | undefined;
}>): AiDefinition | undefined {
    const folderCandidates = [
        normalizePath(folder),
        ...fallbackFolders.map((fallbackFolder) => normalizePath(fallbackFolder)),
    ];
    const overrideId = folderCandidates.reduce<string | undefined>((found, candidate) => {
        return found || config.folderAiIds.find((entry) => entry.folder === candidate)?.aiId;
    }, undefined);
    return (
        findAiDefinition({
            config,
            aiId: overrideId,
        }) ||
        findAiDefinition({
            config,
            aiId: config.defaultAiId,
        }) ||
        config.aiDefinitions[0]
    );
}

export function findAiDefinition({
    config,
    aiId,
}: Readonly<{
    config: Config;
    aiId: string | undefined;
}>): AiDefinition | undefined {
    return aiId ? config.aiDefinitions.find((definition) => definition.id === aiId) : undefined;
}

/**
 * Point one folder at an AI, or clear its override with an empty `aiId`. Writing the id the folder
 * would inherit anyway still records an override — the user picked that AI explicitly, and it
 * should survive a later change to the default.
 */
export function setFolderAiId({
    config,
    folder,
    aiId,
}: Readonly<{
    config: Config;
    folder: string;
    aiId: string;
}>): Config {
    const normalizedFolder = normalizePath(folder);
    const otherFolders = config.folderAiIds.filter((entry) => entry.folder !== normalizedFolder);
    return normalizeConfig({
        ...config,
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
 * Stands in whenever the config defines no AI, so the AI pane always has something to spawn. Its id
 * is fixed rather than generated because the stand-in isn't persisted until the next save, and an
 * override written against one load has to match the next.
 */
const fallbackAiDefinition: AiDefinition = {
    id: 'default-claude',
    name: 'Claude',
    resumeSessionCommand: 'claude',
    newSessionCommand: '',
};

export function withFallbackAi(config: Readonly<Config>): Config {
    return config.aiDefinitions.length
        ? config
        : {
              ...config,
              aiDefinitions: [
                  fallbackAiDefinition,
              ],
              defaultAiId: fallbackAiDefinition.id,
          };
}

/**
 * Only a missing file is replaced with defaults. Any other failure (a read error, an empty file,
 * unparsable JSON, contents that don't match {@link configShape}) throws, and load-modify-save
 * callers catch it and skip their save so the existing file is preserved.
 */
export async function loadConfig(): Promise<Config> {
    const exists = await stat(configPath)
        .then(() => true)
        .catch(() => false);
    if (!exists) {
        const seeded = withFallbackAi(defaultConfig);
        await writeConfig(seeded);
        return seeded;
    }
    const contents = await readFile(configPath, 'utf-8');
    if (!contents.trim()) {
        throw new Error(
            `Config file at ${configPath} exists but is empty; refusing to overwrite with defaults.`,
        );
    }
    const merged: unknown = {
        ...defaultConfig,
        ...JSON.parse(contents),
    };
    assertValidShape(merged, configShape, {}, `Config file at ${configPath} is invalid.`);
    return normalizeConfig(withFallbackAi(merged));
}

/**
 * Written atomically: a non-atomic write leaves a brief empty-file window, and a concurrent
 * {@link loadConfig} that reads it would throw instead of seeing the previous config.
 */
async function writeConfig(config: Readonly<Config>): Promise<void> {
    const normalized = normalizeConfig(config);
    try {
        await writeFileAtomically({
            path: configPath,
            contents: JSON.stringify(normalized, undefined, 4),
        });
        /** Replacing or deleting an AI's avatar leaves its old file behind; this is the cleanup. */
        await pruneAiAvatars(normalized.aiDefinitions);
    } catch (error) {
        log.warning(`Failed to save config: ${String(error)}`);
        throw error;
    }
}

/**
 * Serializes every config write. Without it, two requests that each load, modify, and save the
 * config interleave and the later save silently drops the earlier one's change.
 */
const configWriteQueue = new PromiseQueue();

/** Replaces the whole config file. Runs after any queued {@link updateConfig} calls finish. */
export async function saveConfig(config: Readonly<Config>): Promise<void> {
    await configWriteQueue.add(async () => await writeConfig(config));
}

/**
 * Load, modify, and save the config as one queued step so concurrent updates can't overwrite each
 * other. Skips the write when `update` returns `undefined` or when the current config can't be
 * read, so a transient read failure never resets the user's settings to defaults.
 */
export async function updateConfig(
    update: (config: Readonly<Config>) => Config | undefined,
): Promise<void> {
    await configWriteQueue.add(async () => {
        const config = await loadConfig().catch(() => undefined);
        const updated = config && update(config);
        if (updated) {
            await writeConfig(updated);
        }
    });
}
