import {type Config, defaultConfig} from '@agent-storm/common';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {dirname, join} from 'node:path';
import {normalizePath} from './paths.js';

const configPath = join(homedir(), '.config', 'agent-storm-web.json');

function normalizeConfig(config: Readonly<Config>): Config {
    return {
        ...config,
        repos: config.repos.map((repo) => ({
            ...repo,
            path: normalizePath(repo.path),
        })),
        hiddenAiPane: config.hiddenAiPane.map((path) => normalizePath(path)),
    };
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
        hiddenAiPane: parsed.hiddenAiPane || defaultConfig.hiddenAiPane,
    };
    return normalizeConfig(merged);
}

export async function saveConfig(config: Readonly<Config>): Promise<void> {
    await mkdir(dirname(configPath), {recursive: true});
    const normalized = normalizeConfig(config);
    await writeFile(configPath, JSON.stringify(normalized, undefined, 4), 'utf-8');
}
