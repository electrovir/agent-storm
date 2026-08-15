// cspell:words upserts

import {defaultConfig, type AiDefinition, type Config} from '@agent-storm/common';
import {log, omitObjectKeys, setFirstLetterCasing, StringCase} from '@augment-vir/common';
import {createHash} from 'node:crypto';
import {mkdir, readFile, rename, stat, writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';
import {pruneAiAvatars} from './ai-avatar.js';
import {configPath} from './file-paths.js';
import {normalizePath} from './paths.js';

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
 * The pre-"Define AI" config keys. Read only by {@link migrateAiConfig}, which converts them into
 * {@link Config.aiDefinitions} the first time a config written by an older build is loaded.
 */
type LegacyAiConfig = {
    aiCmd?: string | undefined;
    resetAiSessionCmd?: string | undefined;
    folderAiCmds?:
        | ReadonlyArray<{
              folder?: string | undefined;
              aiCmd?: string | undefined;
              resetAiSessionCmd?: string | undefined;
          }>
        | undefined;
};

/**
 * Id for a migrated definition, derived from its commands rather than generated. `loadConfig`
 * migrates on every read but only persists on the next save, so a random id would differ between
 * two reads — folder overrides written against one would dangle against the next, and the frontend
 * would compare ids from two different loads and find no match.
 */
function migratedAiId(pair: Readonly<Omit<AiDefinition, 'id' | 'name'>>): string {
    const hash = createHash('sha256')
        .update(`${pair.resumeSessionCommand}\u0000${pair.newSessionCommand}`)
        .digest('hex');
    return `migrated-${hash.slice(0, 16)}`;
}

/** `claude --continue` → `Claude`. Names are cosmetic; the ids are what overrides reference. */
function aiNameFromCommand(command: string): string {
    const firstWord = command.trim().split(/\s+/)[0] || 'AI';
    return setFirstLetterCasing(firstWord, StringCase.Upper);
}

/**
 * Turn a legacy config's command strings into AI definitions, and rewrite its per-folder command
 * overrides into per-folder AI ids. One definition per distinct resume + new-session command pair,
 * so a user who ran `claude` everywhere and `codex` in one worktree ends up with exactly two. Runs
 * on every load and is not itself persisted; the next config save is what writes the result to
 * disk.
 *
 * A config that already has definitions is returned untouched, which is what makes this safe to run
 * on every load. A config with neither definitions nor legacy commands (a fresh install) gets a
 * single `claude` definition so the AI pane still has something to spawn.
 */
export function migrateAiConfig(config: Readonly<Config & LegacyAiConfig>): Config {
    /** Dropped from the returned object so the next save writes them out of the file for good. */
    const withoutLegacy = omitObjectKeys(config, [
        'aiCmd',
        'resetAiSessionCmd',
        'folderAiCmds',
    ]);
    if (config.aiDefinitions.length) {
        return withoutLegacy;
    }
    const globalResume = config.aiCmd?.trim() || 'claude';
    const globalNewSession = config.resetAiSessionCmd?.trim() || '';
    const legacyPairs = [
        {
            resumeSessionCommand: globalResume,
            newSessionCommand: globalNewSession,
        },
        ...(config.folderAiCmds || []).map((entry) => {
            return {
                resumeSessionCommand: entry.aiCmd?.trim() || globalResume,
                newSessionCommand: entry.resetAiSessionCmd?.trim() || globalNewSession,
            };
        }),
    ];
    const definitions = legacyPairs.reduce<AiDefinition[]>((kept, pair) => {
        const alreadyKept = kept.some(
            (definition) =>
                definition.resumeSessionCommand === pair.resumeSessionCommand &&
                definition.newSessionCommand === pair.newSessionCommand,
        );
        if (alreadyKept) {
            return kept;
        }
        const baseName = aiNameFromCommand(pair.resumeSessionCommand);
        const sameNameCount = kept.filter(
            (definition) => definition.name.split(' (')[0] === baseName,
        ).length;
        return [
            ...kept,
            {
                ...pair,
                id: migratedAiId(pair),
                name: sameNameCount ? `${baseName} (${sameNameCount + 1})` : baseName,
            },
        ];
    }, []);
    const findPairId = (pair: Readonly<Omit<AiDefinition, 'id' | 'name'>>): string =>
        definitions.find(
            (definition) =>
                definition.resumeSessionCommand === pair.resumeSessionCommand &&
                definition.newSessionCommand === pair.newSessionCommand,
        )?.id || '';
    const defaultAiId = findPairId({
        resumeSessionCommand: globalResume,
        newSessionCommand: globalNewSession,
    });
    return {
        ...withoutLegacy,
        aiDefinitions: definitions,
        defaultAiId,
        folderAiIds: (config.folderAiCmds || [])
            .map((entry) => {
                return {
                    folder: entry.folder || '',
                    aiId: findPairId({
                        resumeSessionCommand: entry.aiCmd?.trim() || globalResume,
                        newSessionCommand: entry.resetAiSessionCmd?.trim() || globalNewSession,
                    }),
                };
            })
            /** An entry that resolved to the default is what the folder would inherit anyway. */
            .filter((entry) => entry.folder && entry.aiId && entry.aiId !== defaultAiId),
    };
}

export async function loadConfig(): Promise<Config> {
    /**
     * Use `stat` to distinguish "file doesn't exist yet" from any other read failure. The old code
     * collapsed both into "save defaults", which meant a transient read error (or — worse — a brief
     * empty-file window caused by a non-atomic `writeFile`) would silently overwrite the user's
     * config with defaults. Now we ONLY auto-create the file on a true `ENOENT`. Anything else
     * (read failure, empty file, JSON parse error) throws and the caller decides what to do —
     * load-modify-save callers catch and skip their save so the existing file is preserved.
     */
    const exists = await stat(configPath)
        .then(() => true)
        .catch(() => false);
    if (!exists) {
        const seeded = migrateAiConfig(defaultConfig);
        await saveConfig(seeded);
        return seeded;
    }
    const contents = await readFile(configPath, 'utf-8');
    if (!contents.trim()) {
        throw new Error(
            `Config file at ${configPath} exists but is empty; refusing to overwrite with defaults.`,
        );
    }
    const parsed = JSON.parse(contents) as Partial<Config> & LegacyAiConfig;
    const merged: Config & LegacyAiConfig = {
        ...defaultConfig,
        ...parsed,
        repos: parsed.repos || defaultConfig.repos,
        aiDefinitions: parsed.aiDefinitions || defaultConfig.aiDefinitions,
        folderAiIds: parsed.folderAiIds || defaultConfig.folderAiIds,
    };
    return normalizeConfig(migrateAiConfig(merged));
}

/**
 * Write the config atomically: stage to a temp file inside the same directory as the target, then
 * `rename` over the destination. `rename` is atomic on POSIX (and on macOS) when both paths are on
 * the same filesystem — readers either see the prior version or the new version, never an empty or
 * partially-written file. This eliminates the empty-file race that previously caused concurrent
 * `loadConfig` calls (from `/repos/touch`, GitHub-polling auto-disable, etc.) to fall through to
 * the "save defaults" path and wipe the user's settings.
 */
export async function saveConfig(config: Readonly<Config>): Promise<void> {
    await mkdir(dirname(configPath), {
        recursive: true,
    });
    const normalized = normalizeConfig(config);
    const tempPath = `${configPath}.tmp.${process.pid}`;
    try {
        await writeFile(tempPath, JSON.stringify(normalized, undefined, 4), 'utf-8');
        await rename(tempPath, configPath);
        /** Replacing or deleting an AI's avatar leaves its old file behind; this is the cleanup. */
        await pruneAiAvatars(normalized.aiDefinitions);
    } catch (error) {
        log.warning(`Failed to save config: ${String(error)}`);
        throw error;
    }
}
