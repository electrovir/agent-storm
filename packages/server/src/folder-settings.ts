import {
    FolderSettingsApproval,
    folderSettingsShape,
    type approvedFolderSettingsShape,
    type FolderSettings,
} from '@agent-storm/common';
import {assertWrap, check} from '@augment-vir/assert';
import {extractErrorMessage, omitObjectKeys} from '@augment-vir/common';
import {normalizePath} from 'agent-storm-util';
import {
    ConfigFileType,
    deduceFileType,
    findConfigFilesUpward,
    MultipleConfigFilesError,
    parseConfigContents,
    rawFileContentParsers,
} from 'config-vir';
import {convertDuration, type AnyDuration} from 'date-vir';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {dirname} from 'node:path';
import {assertValidShape} from 'object-shape-tester';
import {loadAppState, updateAppState} from './app-state.js';

type ApprovedFolderSettings = typeof approvedFolderSettingsShape.runtimeType;

/** One folder settings file and what became of it. */
type FolderSettingsFile = {
    path: string;
    /** The file's text. Empty when it can't be read. */
    text: string;
    contentHash: string;
    approval: FolderSettingsApproval;
    /** Undefined when the file is skipped or invalid, which `problem` explains. */
    folderSettings: FolderSettings | undefined;
    /** Also set when the file is read but some of its fields are held back. */
    problem: string;
};

/**
 * TS and JS settings files run code when they're read, and a folder's files come from whoever wrote
 * the repo, including the author of a PR being reviewed. They're skipped until the user approves
 * them.
 */
const executableFileTypes: ReadonlyArray<ConfigFileType> = [
    ConfigFileType.Ts,
    ConfigFileType.Js,
];

function hashText(text: string) {
    return createHash('sha256').update(text).digest('hex');
}

function findApproval({
    isApprovalNeeded,
    approvedHash,
    contentHash,
}: Readonly<{
    isApprovalNeeded: boolean;
    approvedHash: string | undefined;
    contentHash: string;
}>) {
    if (!isApprovalNeeded) {
        return FolderSettingsApproval.NotNeeded;
    } else if (approvedHash === contentHash) {
        return FolderSettingsApproval.Approved;
    } else if (approvedHash) {
        return FolderSettingsApproval.Changed;
    } else {
        return FolderSettingsApproval.NeedsApproval;
    }
}

async function readFolderSettingsFile({
    path,
    approvals,
}: Readonly<{
    path: string;
    approvals: ReadonlyArray<Readonly<ApprovedFolderSettings>>;
}>): Promise<FolderSettingsFile> {
    const fileType = deduceFileType(path);
    const isExecutable = !fileType || executableFileTypes.includes(fileType);
    const text = await readFile(path, 'utf8').catch(() => '');
    const contentHash = text ? hashText(text) : '';
    const approvedHash = approvals.find((approval) => approval.path === path)?.contentHash;
    const isApproved = !!contentHash && approvedHash === contentHash;
    const base = {
        path,
        text,
        contentHash,
    };
    if (isExecutable && !isApproved) {
        return {
            ...base,
            approval: findApproval({
                isApprovalNeeded: true,
                approvedHash,
                contentHash,
            }),
            folderSettings: undefined,
            problem:
                "Not read until you approve it, since TS and JS settings files run code when they're read.",
        };
    }
    try {
        const parsed: unknown = isExecutable
            ? await parseConfigContents({
                  configPath: path,
              })
            : assertWrap.isDefined(rawFileContentParsers[assertWrap.isDefined(fileType)])({
                  rawContents: text,
              });
        assertValidShape(parsed, folderSettingsShape, {}, 'Invalid folder settings.');
        /** These fields run commands, so they're held back until the user approves the file. */
        const commandFields = [
            parsed.postWorktreeCmd ? 'postWorktreeCmd' : '',
            parsed.review?.initCmd ? 'review.initCmd' : '',
        ].filter(check.isTruthy);
        const approval = findApproval({
            isApprovalNeeded: isExecutable || !!commandFields.length,
            approvedHash,
            contentHash,
        });
        const isHeldBack =
            approval !== FolderSettingsApproval.NotNeeded &&
            approval !== FolderSettingsApproval.Approved;
        return {
            ...base,
            approval,
            folderSettings: isHeldBack
                ? omitObjectKeys(parsed, [
                      'postWorktreeCmd',
                      'review',
                  ])
                : parsed,
            problem: isHeldBack
                ? `Ignored until you approve this file, since they run commands: ${commandFields.join(', ')}.`
                : '',
        };
    } catch (error) {
        return {
            ...base,
            approval: findApproval({
                isApprovalNeeded: isExecutable,
                approvedHash,
                contentHash,
            }),
            folderSettings: undefined,
            problem: extractErrorMessage(error),
        };
    }
}

/** Every folder settings file the user approved, as its text was then. */
export async function loadFolderSettingsApprovals() {
    return (await loadAppState()).approvedFolderSettings || [];
}

/**
 * Every `.agent-storm/settings.*` file from `folder` up to the home folder, nearest first. The home
 * folder's own is skipped: that's the user's settings file (or the main instance's, for a debug
 * instance), not a folder's.
 */
export async function readFolderSettingsFiles({
    folder,
    approvals,
}: Readonly<{
    folder: string;
    approvals: ReadonlyArray<Readonly<ApprovedFolderSettings>>;
}>): Promise<FolderSettingsFile[]> {
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
                .map(async (path) => {
                    return await readFolderSettingsFile({
                        path,
                        approvals,
                    });
                }),
        );
    } catch (error) {
        return [
            {
                path:
                    error instanceof MultipleConfigFilesError
                        ? error.configPaths.join(', ')
                        : folder,
                text: '',
                contentHash: '',
                approval: FolderSettingsApproval.NotNeeded,
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
    const folderLayers = loadFolderSettingsApprovals()
        .then(async (approvals) => {
            return await readFolderSettingsFiles({
                folder: key,
                approvals,
            });
        })
        .then((files) => {
            return files.map((file) => file.folderSettings).filter(check.isTruthy);
        });
    folderSettingsCache.set(key, {
        readAtMs: Date.now(),
        folderLayers,
    });
    return await folderLayers;
}

/**
 * Approves the settings file at `path` as its text is now, or revokes its approval. Approval covers
 * this file's text only, not files a TS or JS settings file imports.
 */
export async function saveFolderSettingsApproval({
    path,
    contentHash,
    isApproved,
}: Readonly<{
    path: string;
    contentHash: string;
    isApproved: boolean;
}>) {
    if (isApproved) {
        const text = await readFile(path, 'utf8');
        if (hashText(text) !== contentHash) {
            throw new Error(`${path} changed since it was shown. Review it again.`);
        }
    }
    await updateAppState((state) => {
        return {
            ...state,
            approvedFolderSettings: [
                ...(state.approvedFolderSettings || []).filter((entry) => entry.path !== path),
                ...(isApproved
                    ? [
                          {
                              path,
                              contentHash,
                          },
                      ]
                    : []),
            ],
        };
    });
    folderSettingsCache.clear();
}
