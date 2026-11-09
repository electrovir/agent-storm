import {folderSettingsShape, type FolderSettings} from '@agent-storm/common';
import {check} from '@augment-vir/assert';
import {extractErrorMessage, omitObjectKeys} from '@augment-vir/common';
import {
    ConfigFileType,
    deduceFileType,
    findConfigFilesUpward,
    MultipleConfigFilesError,
    parseConfigContents,
} from 'config-vir';
import {convertDuration, type AnyDuration} from 'date-vir';
import {homedir} from 'node:os';
import {dirname} from 'node:path';
import {assertValidShape} from 'object-shape-tester';
import {normalizePath} from './paths.js';

/** One folder settings file and what became of it. */
type FolderSettingsFile = {
    path: string;
    /** Undefined when the file is skipped or invalid, which `problem` explains. */
    folderSettings: FolderSettings | undefined;
    problem: string;
};

/**
 * TS and JS settings files run code when they're read, and a folder's files come from whoever wrote
 * the repo. They're skipped until the user can approve them.
 */
const executableFileTypes: ReadonlyArray<ConfigFileType> = [
    ConfigFileType.Ts,
    ConfigFileType.Js,
];

async function readFolderSettingsFile(path: string): Promise<FolderSettingsFile> {
    const fileType = deduceFileType(path);
    if (!fileType || executableFileTypes.includes(fileType)) {
        return {
            path,
            folderSettings: undefined,
            problem:
                "Skipped: TS and JS settings files run code, so they aren't read until agent-storm can ask you to approve them. Use JSON, YAML, or TOML instead.",
        };
    }
    try {
        const parsed = await parseConfigContents({
            configPath: path,
        });
        assertValidShape(parsed, folderSettingsShape, {}, 'Invalid folder settings.');
        return {
            path,
            folderSettings: {
                ...parsed,
                /** Avatars are files in the user's own data folder, which a repo can't add to. */
                aiDefinitions: parsed.aiDefinitions?.map((definition) => {
                    return omitObjectKeys(definition, ['avatarFile']);
                }),
            },
            problem: '',
        };
    } catch (error) {
        return {
            path,
            folderSettings: undefined,
            problem: extractErrorMessage(error),
        };
    }
}

/**
 * Every `.agent-storm/settings.*` file from `folder` up to the home folder, nearest first. The home
 * folder's own is skipped: that's the user's settings file (or the main instance's, for a debug
 * instance), not a folder's.
 */
export async function readFolderSettingsFiles(folder: string): Promise<FolderSettingsFile[]> {
    const home = homedir();
    try {
        const paths = await findConfigFilesUpward({
            startDirectory: folder,
            stopDirectory: home,
            baseName: '.agent-storm/settings',
        });
        return await Promise.all(
            paths
                .filter((path) => dirname(dirname(path)) !== home)
                .map(async (path) => await readFolderSettingsFile(path)),
        );
    } catch (error) {
        return [
            {
                path:
                    error instanceof MultipleConfigFilesError
                        ? error.configPaths.join(', ')
                        : folder,
                folderSettings: undefined,
                problem: `None of this folder's settings files apply: ${extractErrorMessage(error)}`,
            },
        ];
    }
}

/**
 * How long a folder's settings files are trusted before they're read again. The folder sweep asks
 * for every folder on each pass, so this keeps an idle app from rereading them constantly.
 */
const folderSettingsCacheDuration: AnyDuration = {
    seconds: 30,
};

const folderSettingsCache = new Map<
    string,
    {
        readAtMs: number;
        folderLayers: Promise<FolderSettings[]>;
    }
>();

/** The settings of each of `folder`'s valid settings files, nearest first. */
export async function loadFolderSettings(folder: string): Promise<FolderSettings[]> {
    const key = normalizePath(folder);
    const cached = folderSettingsCache.get(key);
    if (
        cached &&
        Date.now() - cached.readAtMs <
            convertDuration(folderSettingsCacheDuration, {
                milliseconds: true,
            }).milliseconds
    ) {
        return await cached.folderLayers;
    }
    const folderLayers = readFolderSettingsFiles(key).then((files) => {
        return files.map((file) => file.folderSettings).filter(check.isTruthy);
    });
    folderSettingsCache.set(key, {
        readAtMs: Date.now(),
        folderLayers,
    });
    return await folderLayers;
}

/** The nearest folder settings file's non-empty value, picked out by `selectValue`. */
export function findNearestFolderSetting<T>(
    folderLayers: ReadonlyArray<Readonly<FolderSettings>>,
    selectValue: (folderSettings: Readonly<FolderSettings>) => T | undefined,
) {
    return folderLayers.map(selectValue).find((value) => {
        return check.isString(value) ? !!value.trim() : value != undefined;
    });
}
