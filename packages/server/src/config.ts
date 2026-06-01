import {type Config, defaultConfig} from '@agent-storm/common';
import {type ArrayElement} from '@augment-vir/common';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
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
    const contents = await readFile(configPath, 'utf-8').catch(() => undefined);
    if (!contents) {
        await saveConfig(defaultConfig);
        return defaultConfig;
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

export async function saveConfig(config: Readonly<Config>): Promise<void> {
    await mkdir(dirname(configPath), {
        recursive: true,
    });
    const normalized = normalizeConfig(config);
    await writeFile(configPath, JSON.stringify(normalized, undefined, 4), 'utf-8');
}
