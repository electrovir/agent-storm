import {reviewBranchPrefix, tryGit} from 'agent-storm-util';
import {readdir, readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {checkValidShape, defineShape, recordShape} from 'object-shape-tester';
import {isSafeBranchName} from './branch-name.js';
import {readReviewHost} from './review-host.js';

const fileExplanationsShape = defineShape(
    recordShape({
        keys: '',
        values: '',
    }),
);

/**
 * The explanation the manual-review skill wrote for each file of the review the folder holds, keyed
 * by repo-relative path. The skill keeps them in its review notes' git dir, as
 * `<reviewer>-review-explanations-<head branch>.json`, and deletes the file when the review ends.
 * Empty when the folder is not on a review branch or the skill wrote none.
 */
export async function readReviewExplanations(
    folder: string,
): Promise<Readonly<Record<string, string>>> {
    const branch = await readReviewHost().getCurrentBranch(folder);
    const headBranch = branch?.startsWith(reviewBranchPrefix)
        ? branch.slice(reviewBranchPrefix.length)
        : undefined;
    const gitDir = headBranch
        ? (
              await tryGit(folder, [
                  'rev-parse',
                  '--absolute-git-dir',
              ])
          )?.trim()
        : undefined;
    if (!headBranch || !isSafeBranchName(headBranch) || !gitDir) {
        return {};
    }
    /** The skill flattens the branch's slashes so the note stays one file. */
    const suffix = `-review-explanations-${headBranch.replaceAll('/', '-')}.json`;
    const fileName = (await readdir(gitDir).catch(() => [])).find((name) => name.endsWith(suffix));
    if (!fileName) {
        return {};
    }
    try {
        const parsed: unknown = JSON.parse(await readFile(join(gitDir, fileName), 'utf8'));
        return checkValidShape(parsed, fileExplanationsShape) ? parsed : {};
    } catch {
        return {};
    }
}
