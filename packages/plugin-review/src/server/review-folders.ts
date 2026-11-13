import {extractErrorMessage, log} from '@augment-vir/common';
import {
    deleteFolderInChildProcess,
    deleteMovedFolder,
    moveAside,
    reviewBranchPrefix,
    tryGit,
    userDataDir,
} from 'agent-storm-util';
import {lstat, readdir} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {readManualReviewEntry, toReviewFolder} from './manual-review-state.js';
import {readReviewHost} from './review-host.js';

/** Review folders get moved here to be deleted in the background. */
const deletingReviewFoldersDir = resolve(userDataDir, 'deleting');

/**
 * The checkout the PR of the folder's branch is being reviewed in, made by `/manual-review here` or
 * by the Review tab. Undefined when the folder isn't on a branch, the skill has no PR recorded for
 * that branch, or the review folder isn't a checkout yet.
 */
export async function findManualReviewCopy(folder: string) {
    const [
        branch,
        slug,
    ] = await Promise.all([
        readReviewHost().getCurrentBranch(folder),
        readReviewHost().getRepoSlug(folder),
    ]);
    if (!branch || !slug) {
        return undefined;
    }
    const prNumber = (
        await readManualReviewEntry({
            owner: slug.owner,
            repoName: slug.name,
            branchName: branch,
        })
    )?.prNumber;
    if (!prNumber) {
        return undefined;
    }
    const copy = toReviewFolder({
        owner: slug.owner,
        repoName: slug.name,
        number: prNumber,
    });
    return (await tryGit(copy, [
        'rev-parse',
        '--git-dir',
    ])) == undefined
        ? undefined
        : copy;
}

/**
 * Whether the folder is a copy `/manual-review here` made, which `run-here.sh` marks with a
 * `<reviewer name>-review-pr` note in the copy's git dir. A review the Review tab started lives at
 * the same kind of path but has no note.
 */
export async function isManualReviewHereCopy(folder: string) {
    const gitDir = (
        await tryGit(folder, [
            'rev-parse',
            '--absolute-git-dir',
        ])
    )?.trim();
    return (
        !!gitDir &&
        (await readdir(gitDir).catch(() => [])).some((name) => name.endsWith('-review-pr'))
    );
}

/**
 * Deletes a review folder along with its `review__` branch. Also handles a folder that's a full
 * clone, the last worktree of its repo, or no checkout at all.
 */
export async function deleteReviewFolder(folder: string) {
    const isCheckout = !!(await lstat(join(folder, '.git')).catch(() => undefined));
    const [
        commonDir,
        branch,
    ] = isCheckout
        ? await Promise.all([
              tryGit(folder, [
                  'rev-parse',
                  '--path-format=absolute',
                  '--git-common-dir',
              ]),
              tryGit(folder, [
                  'branch',
                  '--show-current',
              ]),
          ])
        : [];
    const gitDir = commonDir?.trim();
    const movedPath = await moveAside({
        folder,
        deletingDir: deletingReviewFoldersDir,
    });
    if (gitDir) {
        await tryGit(gitDir, [
            '--git-dir',
            gitDir,
            'worktree',
            'remove',
            '--force',
            '--force',
            folder,
        ]);
    }
    await deleteMovedFolder({
        folder,
        movedPath,
    });
    if (!gitDir) {
        return;
    }
    await tryGit(gitDir, [
        '--git-dir',
        gitDir,
        'worktree',
        'prune',
    ]);
    const reviewBranch = branch?.trim();
    if (reviewBranch?.startsWith(reviewBranchPrefix)) {
        await tryGit(gitDir, [
            '--git-dir',
            gitDir,
            'branch',
            '-D',
            reviewBranch,
        ]);
    }
}

/**
 * Deletes what {@link deleteReviewFolder} moved aside but didn't finish deleting before the server
 * stopped.
 */
export async function sweepDeletingReviewFolders() {
    const names = await readdir(deletingReviewFoldersDir).catch(() => []);
    await Promise.all(
        names.map(async (name) => {
            const path = join(deletingReviewFoldersDir, name);
            await deleteFolderInChildProcess(path).catch((error: unknown) => {
                log.warning(`Failed to delete ${path}: ${extractErrorMessage(error)}`);
            });
        }),
    );
}
