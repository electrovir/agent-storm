// cspell:words numstat

import {tryGit} from './git.js';

const testFilePattern = /\.(?:test|spec)(?:\.e2e)?\.[cm]?[jt]sx?$/;
/** Playwright writes baselines to `<test file>-screenshots/`, Jest and Vitest to `__snapshots__/`. */
const testOutputDirPattern = /(?:^|\/)(?:__snapshots__|[^/]*screenshots)\//;

/** False for a test file or a test's saved output, such as a screenshot baseline. */
export function isReviewablePath(path: string) {
    return !testFilePattern.test(path) && !testOutputDirPattern.test(path);
}

/**
 * Whether a push from `oldHeadSha` to `newHeadSha` changed anything worth re-reading: a file in the
 * PR's diff whose change is more than whitespace and that passes `isReviewablePath`. Files that
 * differ only because a rebase moved the base under them don't count. Anything git can't answer
 * counts as reviewable.
 */
export async function hasReviewableChanges({
    folder,
    baseBranch,
    oldHeadSha,
    newHeadSha,
}: Readonly<{
    folder: string;
    baseBranch: string;
    oldHeadSha: string;
    newHeadSha: string;
}>) {
    const [
        oldPrFiles,
        newPrFiles,
        pushChanges,
    ] = await Promise.all([
        ...[
            oldHeadSha,
            newHeadSha,
        ].map(async (headSha) => {
            return await tryGit(folder, [
                'diff',
                '-z',
                '--name-only',
                '--no-renames',
                `origin/${baseBranch}...${headSha}`,
            ]);
        }),
        /**
         * `--numstat` leaves out files whose only change is whitespace; `--name-only` still lists
         * them.
         */
        tryGit(folder, [
            'diff',
            '-z',
            '--numstat',
            '--no-renames',
            '--ignore-all-space',
            '--ignore-blank-lines',
            oldHeadSha,
            newHeadSha,
        ]),
    ]);
    if (oldPrFiles == undefined || newPrFiles == undefined || pushChanges == undefined) {
        return true;
    }
    const prFiles = [
        ...oldPrFiles.split('\0'),
        ...newPrFiles.split('\0'),
    ];
    return pushChanges.split('\0').some((entry) => {
        const path = entry.split('\t')[2];
        return !!path && prFiles.includes(path) && isReviewablePath(path);
    });
}
