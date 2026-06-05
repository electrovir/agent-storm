import {defaultConfig, type Config} from '@agent-storm/common';
import {log, type ArrayElement} from '@augment-vir/common';
import {mkdir, readFile, rename, stat, writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';
import {configPath} from './file-paths.js';
import {normalizePath} from './paths.js';

function normalizeConfig(config: Readonly<Config>): Config {
    return {
        ...config,
        repos: config.repos.map((repo) => ({
            ...repo,
            path: normalizePath(repo.path),
        })),
        folderAiCmds: config.folderAiCmds
            .filter((entry) => entry.aiCmd.trim())
            .map((entry) => ({
                folder: normalizePath(entry.folder),
                aiCmd: entry.aiCmd.trim(),
            })),
        hiddenAiPane: config.hiddenAiPane.map((path) => normalizePath(path)),
    };
}

export function getFolderAiCmd({
    config,
    folder,
    fallbackFolders = [],
}: Readonly<{
    config: Config;
    folder: string;
    fallbackFolders?: ReadonlyArray<string> | undefined;
}>): string {
    const folderCandidates = [
        normalizePath(folder),
        ...fallbackFolders.map((fallbackFolder) => normalizePath(fallbackFolder)),
    ];
    const matchingOverride = folderCandidates.reduce<
        ArrayElement<typeof config.folderAiCmds> | undefined
    >(
        (found, candidate) =>
            found || config.folderAiCmds.find((entry) => entry.folder === candidate),
        undefined,
    );
    return matchingOverride?.aiCmd || config.aiCmd;
}

export function setFolderAiCmd({
    config,
    folder,
    aiCmd,
}: Readonly<{
    config: Config;
    folder: string;
    aiCmd: string;
}>): Config {
    const normalizedFolder = normalizePath(folder);
    const trimmedAiCmd = aiCmd.trim();
    const otherFolderAiCmds = config.folderAiCmds.filter(
        (entry) => entry.folder !== normalizedFolder,
    );
    return normalizeConfig({
        ...config,
        folderAiCmds:
            trimmedAiCmd && trimmedAiCmd !== config.aiCmd
                ? [
                      ...otherFolderAiCmds,
                      {
                          folder: normalizedFolder,
                          aiCmd: trimmedAiCmd,
                      },
                  ]
                : otherFolderAiCmds,
    });
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
        await saveConfig(defaultConfig);
        return defaultConfig;
    }
    const contents = await readFile(configPath, 'utf-8');
    if (!contents.trim()) {
        throw new Error(
            `Config file at ${configPath} exists but is empty; refusing to overwrite with defaults.`,
        );
    }
    const parsed = JSON.parse(contents) as Partial<Config>;
    const merged: Config = {
        ...defaultConfig,
        ...parsed,
        repos: parsed.repos || defaultConfig.repos,
        folderAiCmds: parsed.folderAiCmds || defaultConfig.folderAiCmds,
        hiddenAiPane: parsed.hiddenAiPane || defaultConfig.hiddenAiPane,
    };
    return normalizeConfig(merged);
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
    } catch (error) {
        log.warning(`Failed to save config: ${String(error)}`);
        throw error;
    }
}
