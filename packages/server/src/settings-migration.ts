import {ForgeType, type Settings} from '@agent-storm/common';
import {check} from '@augment-vir/assert';
import {
    getObjectTypedKeys,
    log,
    omitObjectKeys,
    pickObjectKeys,
    type UnknownObject,
} from '@augment-vir/common';
import {readFileIfExists} from '@augment-vir/node';
import {mkdir, rename} from 'node:fs/promises';
import {join} from 'node:path';
import {assertValidShape, defineShape, nullableShape, optionalShape} from 'object-shape-tester';
import {githubPollingAutoDisableShape, writeAppState, type AppState} from './app-state.js';
import {
    configBackupDir,
    legacyConfigPath,
    legacyReviewConfigPath,
    settingsJsonPath,
} from './file-paths.js';
import {findSettingsPath, parseSettings, saveSettings} from './settings.js';

/**
 * Keys that older builds wrote at the top level of the config, before they moved to
 * `forges.github`.
 */
const legacyGitHubConfigKeys = [
    'disabledGitHubPolling',
    'githubPollingAutoDisable',
    'trustedBotLogins',
] as const;

/**
 * Moves {@link legacyGitHubConfigKeys} under `forges.github`. Returns `undefined` when the config
 * has none of them.
 */
export function migrateLegacyGitHubKeys(
    parsed: Readonly<UnknownObject>,
): UnknownObject | undefined {
    const legacyValues = pickObjectKeys(parsed, legacyGitHubConfigKeys);
    if (!getObjectTypedKeys(legacyValues).length) {
        return undefined;
    }
    const forges = check.isObject(parsed.forges) ? parsed.forges : {};
    const github = check.isObject(forges[ForgeType.Github]) ? forges[ForgeType.Github] : {};
    return {
        ...omitObjectKeys(parsed, legacyGitHubConfigKeys),
        forges: {
            ...forges,
            [ForgeType.Github]: {
                ...legacyValues,
                ...github,
            },
        },
    };
}

/** The parts of the old `config.json` that aren't settings. */
const legacyConfigStateShape = defineShape({
    repos: optionalShape(
        [
            {
                path: '',
                postWorktreeCmd: nullableShape(''),
                lastInteractedAtMs: optionalShape(0, {
                    alsoUndefined: true,
                }),
            },
        ],
        {
            alsoUndefined: true,
        },
    ),
    githubPollingAutoDisable: githubPollingAutoDisableShape,
});

/**
 * Splits the old `config.json` (and `review-config.json`) into the user's settings and the app's
 * own state. Pure, so it can be checked without touching the user's files.
 */
export function splitLegacyConfig({
    legacyConfig,
    legacyReviewConfig,
}: Readonly<{
    legacyConfig: Readonly<UnknownObject>;
    legacyReviewConfig: Readonly<UnknownObject> | undefined;
}>): {settings: Settings; appState: AppState} {
    const migrated = migrateLegacyGitHubKeys(legacyConfig) || legacyConfig;
    const forges = check.isObject(migrated.forges) ? migrated.forges : {};
    const github = check.isObject(forges[ForgeType.Github]) ? forges[ForgeType.Github] : {};
    const legacyState = {
        repos: migrated.repos,
        githubPollingAutoDisable: github.githubPollingAutoDisable || null,
    };
    assertValidShape(legacyState, legacyConfigStateShape, {}, 'The old config is invalid.');
    const repos = legacyState.repos || [];
    const settings = parseSettings({
        rawSettings: {
            ...omitObjectKeys(migrated, ['repos']),
            postWorktreeCmd: migrated.postWorktreeCmd || '',
            folderPostWorktreeCmds: repos
                .filter((repo) => repo.postWorktreeCmd)
                .map((repo) => {
                    return {
                        folder: repo.path,
                        postWorktreeCmd: repo.postWorktreeCmd || '',
                    };
                }),
            forges: {
                ...forges,
                [ForgeType.Github]: omitObjectKeys(github, ['githubPollingAutoDisable']),
            },
            ...(legacyReviewConfig && {
                review: {
                    initCmd: legacyReviewConfig.defaultInitCmd || '',
                    repos: legacyReviewConfig.repos || [],
                },
            }),
        },
        source: 'the old config',
    });
    return {
        settings,
        appState: {
            repos: repos.map((repo) => {
                return pickObjectKeys(repo, [
                    'path',
                    'lastInteractedAtMs',
                ]);
            }),
            githubPollingAutoDisable: legacyState.githubPollingAutoDisable,
        },
    };
}

function parseLegacyJson({contents, path}: Readonly<{contents: string; path: string}>) {
    const parsed: unknown = JSON.parse(contents);
    if (!check.isObject(parsed)) {
        throw new TypeError(`${path} is not a JSON object.`);
    }
    return parsed;
}

/**
 * Moves the old `config.json` and `review-config.json` over to `settings.json` and `state.json`,
 * then moves the old files into the backups. Does nothing once they're gone. Throws when they can't
 * be read, so the server never starts without the user's repos and settings.
 */
export async function migrateLegacyConfigFiles() {
    const [
        legacyConfigContents,
        legacyReviewConfigContents,
    ] = await Promise.all([
        readFileIfExists(legacyConfigPath),
        readFileIfExists(legacyReviewConfigPath),
    ]);
    if (legacyConfigContents == undefined && legacyReviewConfigContents == undefined) {
        return;
    }
    const existingSettingsPath = await findSettingsPath();
    if (existingSettingsPath) {
        log.warning(
            `Not migrating ${legacyConfigPath}: ${existingSettingsPath} already exists. Move the old file away to stop this warning.`,
        );
        return;
    }
    const {settings, appState} = splitLegacyConfig({
        legacyConfig:
            legacyConfigContents == undefined
                ? {}
                : parseLegacyJson({
                      contents: legacyConfigContents,
                      path: legacyConfigPath,
                  }),
        legacyReviewConfig:
            legacyReviewConfigContents == undefined
                ? undefined
                : parseLegacyJson({
                      contents: legacyReviewConfigContents,
                      path: legacyReviewConfigPath,
                  }),
    });
    await writeAppState(appState);
    await saveSettings(settings);
    await mkdir(configBackupDir, {
        recursive: true,
    });
    await Promise.all(
        [
            {
                path: legacyConfigPath,
                exists: legacyConfigContents != undefined,
                backupName: 'config-migrated.json',
            },
            {
                path: legacyReviewConfigPath,
                exists: legacyReviewConfigContents != undefined,
                backupName: 'review-config-migrated.json',
            },
        ]
            .filter((legacyFile) => legacyFile.exists)
            .map(async (legacyFile) => {
                await rename(legacyFile.path, join(configBackupDir, legacyFile.backupName));
            }),
    );
    log.info(
        `Migrated the old config to ${settingsJsonPath}. The old files are in ${configBackupDir}.`,
    );
}
