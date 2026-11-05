import type {ReviewQueuePr} from './api.js';

/** The skill's last step opens VS Code unless this is set. */
export const skipEditorInstruction =
    'Run the runner with CODE_REVIEW_SKIP_EDITOR=1 in its environment so it does not open an editor; agent-storm opens its Diff tab instead.';

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
    return [
        isPrCheckedOut ? '/manual-review here' : `/manual-review start ${pullRequest.url}`,
        `Run it in ${folder} rather than in any other checkout.`,
        `If that folder is empty, first make it a checkout of ${pullRequest.owner}/${pullRequest.repoName}: a detached git worktree (git worktree add --detach) of an existing local clone if there is one, otherwise a git clone. Then run the start runner from it.`,
        skipEditorInstruction,
    ].join(' ');
}
