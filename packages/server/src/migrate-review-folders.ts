import {check} from '@augment-vir/assert';
import {
    awaitedBlockingMap,
    awaitedForEach,
    extractErrorMessage,
    getObjectTypedEntries,
    log,
    mapObjectValuesSync,
} from '@augment-vir/common';
import {doesPathContain, readFileIfExists} from '@augment-vir/node';
import {runCommand, writeFileAtomically} from 'agent-storm';
import {mkdir, readdir, rename, rm, rmdir, stat} from 'node:fs/promises';
import {basename, dirname, join, relative, sep} from 'node:path';
import {defineShape, parseJsonWithShape, recordShape, unknownShape} from 'object-shape-tester';
import {
    listManualReviewEntries,
    readManualReviewFile,
    reviewBranchPrefix,
    type ListedManualReviewEntry,
} from './manual-review-state.js';
import {withManualReviewStateLock} from './review-comments.js';

/** Names directly in the skill's folder that belong to the skill rather than to a repo. */
const skillOwnedNames: ReadonlyArray<string> = [
    'edits',
];

/** A file keyed by folder path, such as the pane sessions or folder activity file. */
const folderKeyedFileShape = defineShape(
    recordShape({
        keys: '',
        values: unknownShape(),
    }),
);

type FolderMove = {
    from: string;
    to: string;
    /** Empty parents of {@link FolderMove.from} are removed up to, but not including, this. */
    stopAt: string;
};

async function listSubfolders(folder: string) {
    const entries = await readdir(folder, {
        withFileTypes: true,
    }).catch(() => []);
    return entries.filter((entry) => entry.isDirectory()).map((entry) => join(folder, entry.name));
}

async function exists(path: string) {
    return !!(await stat(path).catch(() => undefined));
}

/**
 * Every checkout below `folder`. A checkout's own subfolders aren't searched. The return type is
 * annotated because the function recurses.
 */
async function findCheckouts(folder: string): Promise<string[]> {
    if (await exists(join(folder, '.git'))) {
        return [
            folder,
        ];
    } else {
        return (
            await Promise.all((await listSubfolders(folder)).map((child) => findCheckouts(child)))
        ).flat();
    }
}

/** Removes each empty folder from `folder` up to, but not including, `stopAt`. */
async function removeEmptyParents({folder, stopAt}: Readonly<{folder: string; stopAt: string}>) {
    if (
        !doesPathContain({
            potentialParentPath: stopAt,
            potentialChildPath: folder,
        })
    ) {
        return;
    }
    try {
        await rmdir(folder);
    } catch {
        return;
    }
    await removeEmptyParents({
        folder: dirname(folder),
        stopAt,
    });
}

/**
 * The checkouts older versions kept directly in the skill's folder: `<repo>/<head branch>` and the
 * `<repo>/review__<head branch>` copies `/manual-review here` made, each paired with the review
 * folder of its PR. A checkout with no PR in the state file is a `/manual-review local` copy and is
 * left alone.
 */
async function planSkillFolderMoves({
    reviewsDir,
    entries,
}: Readonly<{
    reviewsDir: string;
    entries: ReadonlyArray<ListedManualReviewEntry>;
}>) {
    const repoFolders = (await listSubfolders(reviewsDir)).filter((folder) => {
        return !skillOwnedNames.includes(basename(folder));
    });
    const checkouts = (
        await Promise.all(
            repoFolders.map(async (repoFolder) => {
                return (await findCheckouts(repoFolder)).map((folder) => {
                    return {
                        folder,
                        repoName: basename(repoFolder),
                        branchName: relative(repoFolder, folder).split(sep).join('/'),
                    };
                });
            }),
        )
    ).flat();
    return checkouts.flatMap(({folder, repoName, branchName}): FolderMove[] => {
        const recordedMatches = entries.filter((listed) => {
            return listed.entry.folder === folder && !!listed.entry.prNumber;
        });
        /** A `here` copy's name flattens the branch's slashes, so only its recorded entry finds it. */
        const branchMatches = basename(folder).startsWith(reviewBranchPrefix)
            ? []
            : entries.filter((listed) => {
                  return (
                      listed.repoName === repoName &&
                      listed.branchName === branchName &&
                      !!listed.entry.prNumber
                  );
              });
        const matches = recordedMatches.length ? recordedMatches : branchMatches;
        const match = matches[0];
        if (!match?.entry.prNumber) {
            return [];
        } else if (check.isLengthExactly(matches, 1)) {
            const destination = join(
                reviewsDir,
                match.owner,
                match.repoName,
                String(match.entry.prNumber),
            );
            return destination === folder
                ? []
                : [
                      {
                          from: folder,
                          to: destination,
                          stopAt: reviewsDir,
                      },
                  ];
        } else {
            log.warning(
                `Left ${folder} in place: more than one PR in the manual-review state file matches it.`,
            );
            return [];
        }
    });
}

/** The `<owner>/<repo>/<PR number>` folders the Review tab used to make in `legacyReviewsDir`. */
async function planLegacyReviewMoves({
    reviewsDir,
    legacyReviewsDir,
}: Readonly<{
    reviewsDir: string;
    legacyReviewsDir: string;
}>) {
    const prFolders = (
        await Promise.all(
            (await listSubfolders(legacyReviewsDir)).map(async (ownerFolder) => {
                return (
                    await Promise.all((await listSubfolders(ownerFolder)).map(listSubfolders))
                ).flat();
            }),
        )
    ).flat();
    return prFolders
        .filter((folder) => /^[1-9]\d*$/.test(basename(folder)))
        .map((folder): FolderMove => {
            return {
                from: folder,
                to: join(reviewsDir, relative(legacyReviewsDir, folder)),
                stopAt: dirname(legacyReviewsDir),
            };
        });
}

/**
 * A worktree is moved with `git worktree move` so its repo keeps track of it. An empty destination,
 * as the Review tab makes before a review starts, is replaced.
 */
async function moveFolder({from, to, stopAt}: Readonly<FolderMove>) {
    const destinationEntries = await readdir(to).catch(() => undefined);
    if (destinationEntries?.length) {
        log.warning(`Left ${from} in place: ${to} already exists.`);
        return false;
    }
    try {
        if (destinationEntries) {
            await rmdir(to);
        }
        await mkdir(dirname(to), {
            recursive: true,
        });
        if ((await stat(join(from, '.git')).catch(() => undefined))?.isFile()) {
            await runCommand(
                'git',
                [
                    'worktree',
                    'move',
                    from,
                    to,
                ],
                {
                    cwd: from,
                    timeout: {
                        seconds: 30,
                    },
                },
            );
        } else {
            await rename(from, to);
        }
        log.info(`Moved ${from} to ${to}.`);
    } catch (error) {
        log.warning(`Failed to move ${from} to ${to}: ${extractErrorMessage(error)}`);
        return false;
    }
    await removeEmptyParents({
        folder: dirname(from),
        stopAt,
    });
    return true;
}

/** Points each state file entry recorded for a moved folder at where it went. */
async function rewriteStateFolders({
    statePath,
    newPaths,
}: Readonly<{
    statePath: string;
    newPaths: Readonly<Record<string, string>>;
}>) {
    await withManualReviewStateLock({
        statePath,
        async callback() {
            const state = await readManualReviewFile(statePath);
            const updated = mapObjectValuesSync(state, (repoKey, branches) => {
                return mapObjectValuesSync(branches, (branchName, entry) => {
                    const newPath =
                        check.isObject(entry) && check.isString(entry.folder)
                            ? newPaths[entry.folder]
                            : undefined;
                    return newPath && check.isObject(entry)
                        ? {
                              ...entry,
                              folder: newPath,
                          }
                        : entry;
                });
            });
            await writeFileAtomically({
                path: statePath,
                contents: `${JSON.stringify(updated, undefined, 4)}\n`,
            });
        },
    });
}

/**
 * Moves a folder-keyed file from `legacyPath` to `path` when `path` doesn't exist yet, and renames
 * the keys of moved folders. A key whose new path already has an entry keeps the newer entry.
 */
async function migrateFolderKeyedFile({
    legacyPath,
    path,
    newPaths,
}: Readonly<{
    legacyPath: string;
    path: string;
    newPaths: Readonly<Record<string, string>>;
}>) {
    const hasMoved = await exists(path);
    const sourcePath = hasMoved ? path : legacyPath;
    if (hasMoved && !Object.keys(newPaths).length) {
        return;
    }
    const contents = await readFileIfExists(sourcePath);
    if (!contents?.trim()) {
        return;
    }
    const file = parseJsonWithShape(contents, folderKeyedFileShape);
    const remapped: Record<string, unknown> = {};
    getObjectTypedEntries(file).forEach(
        ([
            folder,
            value,
        ]) => {
            const newPath = newPaths[folder];
            if (!newPath) {
                remapped[folder] = value;
            } else if (!(newPath in file)) {
                remapped[newPath] = value;
            }
        },
    );
    await writeFileAtomically({
        path,
        contents: JSON.stringify(remapped, undefined, 4),
    });
    if (!hasMoved) {
        await rm(legacyPath, {
            force: true,
        });
        log.info(`Moved ${legacyPath} to ${path}.`);
    }
}

/**
 * Moves review folders from where older versions kept them into `<reviewsDir>/<owner>/<repo>/<PR
 * number>`, and moves the folder-keyed state files to their current paths. Each moved folder's
 * entry in the skill's state file and its keys in the folder-keyed files follow it. A folder whose
 * destination already holds something is logged and left where it is.
 */
export async function migrateReviewFolders({
    reviewsDir,
    legacyReviewsDir,
    folderKeyedFiles,
}: Readonly<{
    /** The manual-review skill's folder, which holds its `state.json`. */
    reviewsDir: string;
    legacyReviewsDir: string;
    folderKeyedFiles: ReadonlyArray<
        Readonly<{
            legacyPath: string;
            path: string;
        }>
    >;
}>) {
    const statePath = join(reviewsDir, 'state.json');
    const entries = await readManualReviewFile(statePath)
        .then(listManualReviewEntries)
        .catch((error: unknown) => {
            log.warning(
                `Not moving old review checkouts: can't read the manual-review state file: ${extractErrorMessage(error)}`,
            );
            return undefined;
        });
    /** Checkouts the skill recorded go first, so they win a destination over an unrecorded one. */
    const plannedMoves = [
        ...(entries
            ? await planSkillFolderMoves({
                  reviewsDir,
                  entries,
              })
            : []),
        ...(await planLegacyReviewMoves({
            reviewsDir,
            legacyReviewsDir,
        })),
    ];
    const moves = (
        await awaitedBlockingMap(plannedMoves, async (move) => {
            return (await moveFolder(move))
                ? [
                      move,
                  ]
                : [];
        })
    ).flat();
    const newPaths: Record<string, string> = {};
    moves.forEach(({from, to}) => {
        newPaths[from] = to;
    });

    if (moves.length && entries) {
        try {
            await rewriteStateFolders({
                statePath,
                newPaths,
            });
        } catch (error) {
            log.warning(
                `Failed to update moved review folders in the manual-review state file: ${extractErrorMessage(error)}`,
            );
        }
    }
    await awaitedForEach(folderKeyedFiles, async ({legacyPath, path}) => {
        try {
            await migrateFolderKeyedFile({
                legacyPath,
                path,
                newPaths,
            });
        } catch (error) {
            log.warning(`Failed to migrate ${legacyPath}: ${extractErrorMessage(error)}`);
        }
    });
}
