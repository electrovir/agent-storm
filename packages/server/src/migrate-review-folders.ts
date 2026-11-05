import {awaitedForEach, extractErrorMessage, log} from '@augment-vir/common';
import {doesPathContain} from '@augment-vir/node';
import {mkdir, readdir, rename, rmdir, stat} from 'node:fs/promises';
import {basename, dirname, join, relative, sep} from 'node:path';
import {
    listManualReviewEntries,
    readManualReviewFile,
    reviewBranchPrefix,
} from './manual-review-state.js';
import {runCommand} from './run-command.js';

/** Names directly in the skill's folder that belong to the skill rather than to a repo. */
const skillOwnedNames: ReadonlyArray<string> = [
    'edits',
];

async function listSubfolders(folder: string) {
    const entries = await readdir(folder, {
        withFileTypes: true,
    }).catch(() => []);
    return entries.filter((entry) => entry.isDirectory()).map((entry) => join(folder, entry.name));
}

/**
 * Every checkout below `folder`, not counting `/manual-review here` copies. A checkout's own
 * subfolders aren't searched. The return type is annotated because the function recurses.
 */
async function findCheckouts(folder: string): Promise<string[]> {
    if (basename(folder).startsWith(reviewBranchPrefix)) {
        return [];
    } else if (await stat(join(folder, '.git')).catch(() => undefined)) {
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
 * Moves review folders from where older versions kept them, `<skillDir>/<repo>/<head branch>`, to
 * `<reviewsDir>/<owner>/<repo>/<PR number>`, finding each one's PR in the skill's state file. A
 * worktree is moved with `git worktree move` so its repo keeps track of it. A folder that doesn't
 * match exactly one PR, or whose destination already exists, is logged and left where it is.
 */
export async function migrateReviewFolders({
    skillDir,
    reviewsDir,
}: Readonly<{
    skillDir: string;
    reviewsDir: string;
}>) {
    const entries = await readManualReviewFile(join(skillDir, 'state.json'))
        .then(listManualReviewEntries)
        .catch((error: unknown) => {
            log.warning(
                `Not moving old review folders: can't read the manual-review state file: ${extractErrorMessage(error)}`,
            );
            return undefined;
        });
    if (!entries) {
        return;
    }
    const repoFolders = (await listSubfolders(skillDir)).filter((folder) => {
        return !skillOwnedNames.includes(basename(folder));
    });
    const checkouts = (
        await Promise.all(
            repoFolders.map(async (repoFolder) => {
                return (await findCheckouts(repoFolder)).map((folder) => {
                    return {
                        folder,
                        repoFolder,
                        repoName: basename(repoFolder),
                        branchName: relative(repoFolder, folder).split(sep).join('/'),
                    };
                });
            }),
        )
    ).flat();

    await awaitedForEach(checkouts, async ({folder, repoFolder, repoName, branchName}) => {
        const matches = entries.filter((listed) => {
            return (
                listed.repoName === repoName &&
                listed.branchName === branchName &&
                !!listed.entry.prNumber
            );
        });
        const recordedMatches = matches.filter((listed) => listed.entry.folder === folder);
        const match = recordedMatches.length === 1 ? recordedMatches[0] : matches[0];
        if (!match || (recordedMatches.length !== 1 && matches.length !== 1)) {
            log.warning(
                `Left ${folder} in place: ${matches.length ? 'more than one' : 'no'} PR in the manual-review state file matches it.`,
            );
            return;
        }
        const destination = join(
            reviewsDir,
            match.owner,
            match.repoName,
            String(match.entry.prNumber),
        );
        if (
            !doesPathContain({
                potentialParentPath: reviewsDir,
                potentialChildPath: destination,
            })
        ) {
            log.warning(`Left ${folder} in place: ${destination} is outside ${reviewsDir}.`);
            return;
        } else if (await stat(destination).catch(() => undefined)) {
            log.warning(`Left ${folder} in place: ${destination} already exists.`);
            return;
        }
        try {
            await mkdir(dirname(destination), {
                recursive: true,
            });
            if ((await stat(join(folder, '.git'))).isFile()) {
                await runCommand(
                    'git',
                    [
                        'worktree',
                        'move',
                        folder,
                        destination,
                    ],
                    {
                        cwd: folder,
                        timeout: {
                            seconds: 30,
                        },
                    },
                );
            } else {
                await rename(folder, destination);
            }
            log.info(`Moved ${folder} to ${destination}.`);
        } catch (error) {
            log.warning(
                `Failed to move ${folder} to ${destination}: ${extractErrorMessage(error)}`,
            );
            return;
        }
        await removeEmptyParents({
            folder: dirname(folder),
            stopAt: dirname(repoFolder),
        });
    });
}
