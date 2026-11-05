import {
    createManualReviewPrompt,
    skipEditorInstruction,
    type ManualReviewState,
    type ReviewQueuePr,
} from '@agent-storm/common';
import {convertDuration} from 'date-vir';
import {css, defineElementEvent, html, listen, nothing, unsafeHTML} from 'element-vir';
import {
    reviewPrKey,
    ReviewVerdict,
    type FrontendStateObservable,
} from '../../util/frontend-state.js';
import {sanitizeGitHubHtml} from '../../util/github-markdown.js';
import {defineAppElement} from '../define-app-element.js';
import {loadReviewPanePr} from './review-pane-load.js';
import {markdownStyles} from './review-pane-styles.js';
import {withSentVerdict} from './review-sent-verdict.js';
import {ReviewPaneAction, VirReviewPaneActions} from './vir-review-pane-actions.element.js';
import {VirReviewPaneConversations} from './vir-review-pane-conversations.element.js';
import {VirReviewPaneHeader} from './vir-review-pane-header.element.js';
import {VirReviewPaneReviewers} from './vir-review-pane-reviewers.element.js';

/** The parts of a PR the Review pane reads, which a Build folder's own PR also has. */
export type ReviewPanePr = Pick<
    ReviewQueuePr,
    | 'owner'
    | 'repoName'
    | 'number'
    | 'title'
    | 'titleHtml'
    | 'url'
    | 'bodyHtml'
    | 'branchName'
    | 'author'
    | 'authorAvatarUrl'
>;

/**
 * A `/manual-review` subcommand pinned to `folder`. For a Build folder the skill finds the folder's
 * `/manual-review here` copy itself, so the folder is all it needs.
 */
function createFolderReviewPrompt({command, folder}: Readonly<{command: string; folder: string}>) {
    return `/manual-review ${command} Run it in ${folder} rather than in any other checkout.`;
}

export const VirReviewPane = defineAppElement<{
    pullRequest: Readonly<ReviewPanePr>;
    folder: string;
    /** Undefined when the skill has never recorded a review of the PR's branch. */
    review: Readonly<ManualReviewState> | undefined;
    /** Starts the buttons locked, for a pane mounted after a prompt was already sent. */
    initialPromptSentAt?: number | undefined;
    /** Holds the PR's details. Undefined until IndexedDB opens. */
    frontendState: FrontendStateObservable | undefined;
}>()({
    tagName: 'vir-review-pane',
    events: {
        /**
         * Carries the prompt to type into the AI pane. `isStart` is false for Reset, which reuses
         * the existing checkout.
         */
        manualReviewRequested: defineElementEvent<{
            prompt: string;
            isStart: boolean;
        }>(),
        /** Start Manual Review or Reset was clicked. Follows that click's `manualReviewRequested`. */
        manualReviewStarted: defineElementEvent<void>(),
        /** Approve or Request Changes was clicked. The parent sends its prompt. */
        verdictRequested: defineElementEvent<ReviewVerdict>(),
    },
    state() {
        return {
            /**
             * The review's `lastUpdatedAt` (0 for none) when a prompt was sent. Every button stays
             * disabled until the skill records something newer, so a prompt the AI hasn't acted on
             * yet can't be sent twice.
             */
            promptSentAt: undefined as number | undefined,
            refreshPollHandle: undefined as ReturnType<typeof setInterval> | undefined,
        };
    },
    init({inputs, updateState, host}) {
        updateState({
            promptSentAt: inputs.initialPromptSentAt,
            refreshPollHandle: setInterval(
                async () => {
                    /**
                     * The server caches the PR, so without this a comment posted outside this pane
                     * (on github.com or by the review skill) never shows up. A hidden pane skips
                     * the poll to spare GitHub's rate limit.
                     */
                    const {pullRequest, frontendState} = host.instanceInputs;
                    if (
                        !frontendState ||
                        document.hidden ||
                        !host.checkVisibility() ||
                        frontendState.value.reviewPrs[reviewPrKey(pullRequest)]?.isRefreshing
                    ) {
                        return;
                    }
                    await loadReviewPanePr({
                        frontendState,
                        pullRequest,
                        forceRefresh: true,
                    });
                },
                convertDuration(
                    {
                        seconds: 30,
                    },
                    {
                        milliseconds: true,
                    },
                ).milliseconds,
            ),
        });
    },
    cleanup({state}) {
        clearInterval(state.refreshPollHandle);
    },
    styles: css`
        :host {
            display: flex;
            flex-direction: column;
            align-items: flex-start;
            gap: 16px;
            padding: 16px;
            height: 100%;
            box-sizing: border-box;
            overflow: auto;
        }

        ${markdownStyles}

        ${VirReviewPaneHeader}, .description {
            align-self: stretch;
        }
    `,
    render({inputs, state, updateState, dispatch, events}) {
        const lastUpdatedAt = inputs.review?.lastUpdatedAt ?? 0;
        const isLocked = state.promptSentAt === lastUpdatedAt || !!inputs.review?.isPending;
        const sharedPr = inputs.frontendState?.value.reviewPrs[reviewPrKey(inputs.pullRequest)];
        const loadedPr = sharedPr?.number === inputs.pullRequest.number ? sharedPr : undefined;

        if (inputs.frontendState && !loadedPr) {
            void loadReviewPanePr({
                frontendState: inputs.frontendState,
                pullRequest: inputs.pullRequest,
                forceRefresh: false,
            });
        }

        const prDetails =
            loadedPr?.details &&
            withSentVerdict(
                loadedPr.details,
                inputs.frontendState?.value.verdicts[inputs.pullRequest.url],
            );
        const isRefreshing = !!loadedPr?.isRefreshing;
        const shownPr = prDetails || inputs.pullRequest;

        const actionHandlers: Record<ReviewPaneAction, () => void> = {
            [ReviewPaneAction.Start]() {
                dispatch(
                    new events.manualReviewRequested({
                        detail: {
                            prompt: createManualReviewPrompt(inputs),
                            isStart: true,
                        },
                    }),
                );
                dispatch(
                    new events.manualReviewStarted({
                        detail: undefined,
                    }),
                );
            },
            [ReviewPaneAction.Reset]() {
                dispatch(
                    new events.manualReviewRequested({
                        detail: {
                            prompt: [
                                createFolderReviewPrompt({
                                    command: 'reset',
                                    folder: inputs.folder,
                                }),
                                skipEditorInstruction,
                            ].join(' '),
                            isStart: false,
                        },
                    }),
                );
                dispatch(
                    new events.manualReviewStarted({
                        detail: undefined,
                    }),
                );
            },
            [ReviewPaneAction.Abort]() {
                dispatch(
                    new events.manualReviewRequested({
                        detail: {
                            prompt: createFolderReviewPrompt({
                                command: 'abort',
                                folder: inputs.folder,
                            }),
                            isStart: false,
                        },
                    }),
                );
            },
            [ReviewPaneAction.Approve]() {
                dispatch(
                    new events.verdictRequested({
                        detail: ReviewVerdict.Approve,
                    }),
                );
            },
            [ReviewPaneAction.RequestChanges]() {
                dispatch(
                    new events.verdictRequested({
                        detail: ReviewVerdict.RequestChanges,
                    }),
                );
            },
        };

        return html`
            <${VirReviewPaneHeader.assign({
                author: inputs.pullRequest.author,
                authorAvatarUrl: inputs.pullRequest.authorAvatarUrl,
                pullRequest: shownPr,
                isRefreshing,
            })}
                ${listen(VirReviewPaneHeader.events.refreshRequested, async () => {
                    await loadReviewPanePr({
                        frontendState: inputs.frontendState,
                        pullRequest: inputs.pullRequest,
                        forceRefresh: true,
                    });
                })}
            ></${VirReviewPaneHeader}>
            <${VirReviewPaneReviewers.assign({
                reviewers: prDetails?.reviewers || [],
            })}></${VirReviewPaneReviewers}>
            <${VirReviewPaneActions.assign({
                review: inputs.review,
                isLocked,
            })}
                ${listen(VirReviewPaneActions.events.actionClicked, (event) => {
                    updateState({
                        promptSentAt: lastUpdatedAt,
                    });
                    actionHandlers[event.detail]();
                })}
            ></${VirReviewPaneActions}>
            ${shownPr.bodyHtml
                ? html`
                      <div class="description markdown">
                          ${unsafeHTML(sanitizeGitHubHtml(shownPr.bodyHtml))}
                      </div>
                  `
                : nothing}
            <${VirReviewPaneConversations.assign({
                pullRequest: inputs.pullRequest,
                frontendState: inputs.frontendState,
                prDetails,
                loadError: loadedPr?.loadError || '',
            })}></${VirReviewPaneConversations}>
        `;
    },
});
