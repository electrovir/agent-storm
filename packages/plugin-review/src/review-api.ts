import {
    definePluginApi,
    GitHubCommentTarget,
    gitHubPrShape,
    GitHubReaction,
    manualReviewStateShape,
    pullRequestBranchShape,
    pullRequestRefShape,
    reviewCommentShape,
    reviewPaneId,
    reviewPrShape,
    reviewQueuePrShape,
    reviewQueueResponseShape,
} from '@agent-storm/common';
import {defineShape, enumShape, nullableShape} from 'object-shape-tester';

const folderRequestShape = defineShape({
    folder: '',
});

const okResponseShape = defineShape({
    ok: true,
});

const queueRequestShape = defineShape({
    /**
     * False answers from the server's cache, starting its auto-refresh on the first call. True
     * fetches from GitHub first and answers once that lands.
     */
    forceRefresh: false,
});

const reviewCommentsResponseShape = defineShape({
    comments: [
        reviewCommentShape,
    ],
});

const manualReviewStateResponseShape = defineShape({
    /** Null when the skill has never recorded a review of the branch. */
    review: nullableShape(manualReviewStateShape),
});

/** The Review plugin's calls into its server part. */
export const reviewApi = definePluginApi({
    pluginId: reviewPaneId,
    calls: {
        /** Turns the built-in `/watch-pr` on or off for a folder. */
        setWatchMode: {
            requestShape: defineShape({
                folder: '',
                isEnabled: false,
            }),
            responseShape: okResponseShape,
        },
        /**
         * Closes the window the manual-review skill recorded for the branch's review. Does nothing
         * when no window is open on it, or on an unsupported OS.
         */
        closeEditorWindow: {
            requestShape: pullRequestBranchShape,
            responseShape: okResponseShape,
        },
        /**
         * The comments the reviewer wrote in the diff pane for the review the folder holds, stored
         * in the manual-review skill's state file so its verdict commands post them alongside the
         * comments typed into the code.
         */
        readReviewComments: {
            requestShape: folderRequestShape,
            responseShape: reviewCommentsResponseShape,
        },
        addReviewComment: {
            requestShape: defineShape({
                folder: '',
                path: '',
                line: 0,
                body: '',
            }),
            responseShape: reviewCommentsResponseShape,
        },
        updateReviewComment: {
            requestShape: defineShape({
                folder: '',
                id: '',
                body: '',
            }),
            responseShape: reviewCommentsResponseShape,
        },
        deleteReviewComment: {
            requestShape: defineShape({
                folder: '',
                id: '',
            }),
            responseShape: reviewCommentsResponseShape,
        },
        /**
         * Everything the GitHub pane shows, in one call: the PR itself, each reviewer's verdict,
         * every inline review thread, and the main conversation. One round trip because it's one
         * GraphQL query — splitting it per section would multiply the rate-limit cost for no
         * benefit. `pr` is null when the folder isn't a checkout, its `origin` isn't on github.com,
         * its branch has no PR, or `gh` isn't installed or authenticated.
         */
        readFolderPr: {
            requestShape: defineShape({
                folder: '',
                /**
                 * True skips the server's per-folder cache and queries GitHub. Used by the refresh
                 * button and after posting anything, where the point is to see what actually
                 * landed.
                 */
                forceRefresh: false,
            }),
            responseShape: defineShape({
                pr: nullableShape(gitHubPrShape),
            }),
        },
        /**
         * Open PRs from any repo still waiting on the `gh` account's review, in review-vir's
         * Reviewer-list order. PRs assigned to that account, and PRs review-vir greys out, are left
         * out.
         */
        readReviewQueue: {
            requestShape: queueRequestShape,
            responseShape: reviewQueueResponseShape,
        },
        /**
         * Open PRs, drafts included, assigned to the `gh` account (or authored by it with no
         * assignees), in review-vir's Assignee-list order. Cached and refreshed separately from the
         * review queue.
         */
        readAssigneeQueue: {
            requestShape: queueRequestShape,
            responseShape: reviewQueueResponseShape,
        },
        /**
         * Answers with the folder one queued PR is reviewed in, `<manual-review skill
         * folder>/<owner>/<repo name>/<PR number>`, creating it when asked, plus where the
         * manual-review skill says its review stands. The PR is looked up in the server's cached
         * queue, so a client never names the path. Errors when the PR isn't in the queue.
         */
        resolveReviewFolder: {
            requestShape: defineShape({
                ...pullRequestRefShape.default,
                /** False only resolves the path, so selecting a PR leaves no folder behind. */
                createFolder: false,
            }),
            responseShape: defineShape({
                folder: '',
                pullRequest: reviewQueuePrShape,
                /** Null when the skill has never recorded a review of the PR's branch. */
                review: nullableShape(manualReviewStateShape),
            }),
        },
        /**
         * Types the Review tab's init command for the PR's repo into its review folder's first
         * Shell tab, spawning that tab if it isn't running. Does nothing when no command is set.
         */
        runReviewInit: {
            requestShape: pullRequestRefShape,
            responseShape: okResponseShape,
        },
        /**
         * One PR's title, description, and the review threads the `gh` account started (plus all
         * unresolved threads when it's assigned to the PR). The server caches each PR until a
         * request sets `forceRefresh`.
         */
        readReviewPr: {
            requestShape: defineShape({
                ...pullRequestRefShape.default,
                /**
                 * The server caches each PR by its repo and head branch, which the Build tab
                 * shares.
                 */
                branchName: '',
                /** True skips the server's cache and queries GitHub. */
                forceRefresh: false,
            }),
            responseShape: reviewPrShape,
        },
        /**
         * Finds the folder the PR of a folder's branch is reviewed in, whether `/manual-review
         * here` or the Review tab made it.
         */
        findManualReviewCopy: {
            requestShape: folderRequestShape,
            responseShape: defineShape({
                /** Null until a review folder exists for the folder's branch. */
                folder: nullableShape(''),
            }),
        },
        /** Where the manual-review skill says the review of one PR branch stands. */
        readManualReviewState: {
            requestShape: pullRequestBranchShape,
            responseShape: manualReviewStateResponseShape,
        },
        /** Posts a reply into a review thread, or a new top-level comment on the PR. */
        postGitHubComment: {
            requestShape: defineShape({
                target: enumShape(GitHubCommentTarget),
                subjectId: '',
                body: '',
            }),
            responseShape: okResponseShape,
        },
        setGitHubReaction: {
            requestShape: defineShape({
                /** Node id of the comment being reacted to. */
                subjectId: '',
                reaction: enumShape(GitHubReaction),
                /** True adds the viewer's reaction, false removes it. */
                add: false,
            }),
            responseShape: okResponseShape,
        },
        setGitHubThreadResolved: {
            requestShape: defineShape({
                threadId: '',
                /** True resolves the thread, false reopens it. */
                resolved: false,
            }),
            responseShape: okResponseShape,
        },
    },
});
