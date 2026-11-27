import type {ReviewQueuePr} from './api.js';

/** The skill's last step opens VS Code unless this is set. */
export const skipEditorInstruction =
    'Run the runner with CODE_REVIEW_SKIP_EDITOR=1 in its environment so it does not open an editor; Agent Storm opens its Diff tab instead.';

/**
 * A `/manual-review` subcommand pinned to `folder`. For a Build folder the skill finds the folder's
 * `/manual-review here` copy itself, so the folder is all it needs.
 */
export function createFolderReviewPrompt({
    command,
    folder,
}: Readonly<{command: string; folder: string}>) {
    return `/manual-review ${command} Run it in ${folder} rather than in any other checkout.`;
}

/**
 * The review folder starts empty, while `/manual-review start` expects to run from inside a
 * checkout of the PR's repo, so the prompt has the AI make the folder one first. A Build folder
 * already has the PR's branch checked out, so it uses `/manual-review here` instead.
 */
export function createManualReviewPrompt({
    pullRequest,
    folder,
    isPrCheckedOut,
}: Readonly<{
    pullRequest: Readonly<Pick<ReviewQueuePr, 'owner' | 'repoName' | 'url'>>;
    folder: string;
    isPrCheckedOut?: boolean | undefined;
}>) {
    /**
     * A `here` prompt must not mention the start runner: agents read it as license to run
     * `run-review.sh` in the Build folder itself, checking the review branch out over the folder's
     * own branch instead of reviewing in a copy.
     */
    return (
        isPrCheckedOut
            ? [
                  '/manual-review here',
                  `Run it from ${folder} with run-here.sh, which reviews in a copy and never checks out the review branch in ${folder} itself.`,
              ]
            : [
                  `/manual-review start ${pullRequest.url}`,
                  `Run it in ${folder} rather than in any other checkout.`,
                  `If that folder is empty, first make it a checkout of ${pullRequest.owner}/${pullRequest.repoName}: a detached git worktree (git worktree add --detach) of an existing local clone if there is one, otherwise a git clone. Then run the start runner from it.`,
              ]
    )
        .concat(skipEditorInstruction)
        .join(' ');
}
