import {
    diffPaneId,
    gitHubReviewFolderEndpoint,
    ManualReviewStatus,
    reviewPaneId,
    type ReviewQueuePr,
} from '@agent-storm/common';
import {
    defineAppElement,
    fetchApi,
    ScreenSize,
    VirPaneGroup,
    type AppContext,
} from '@agent-storm/core/frontend';
import {check} from '@augment-vir/assert';
import {extractErrorMessage, omitObjectKeys} from '@augment-vir/common';
import {colorCss} from '@electrovir/color';
import {HttpMethod} from '@rest-vir/api';
import {css, html, nothing, repeat, type Observable} from 'element-vir';
import {themeDefaultKey} from 'theme-vir';
import {viraTheme, viraThemeByKeys} from 'vira';
import {createReviewExtensionInputs} from '../../util/review-extension.js';
import {reviewMemory} from '../../util/review-memory.js';

type ReviewTarget = {
    key: string;
    folder: string;
    pullRequest: ReviewQueuePr;
};

/** The Review tab's stage: each selected pull request's review folder and its panes. */
export const VirReviewStage = defineAppElement<{
    context: AppContext;
    /** The Review activity's route segments. */
    subPaths: ReadonlyArray<string>;
    /** Keyed by `pullRequestRouteKey`. Only set for a PR that's still in a review queue. */
    activePullRequest: string | undefined;
    /** Undefined until the review queue has loaded. */
    reviewQueueKeys: ReadonlyArray<string> | undefined;
    isShown: boolean;
    /**
     * Set to a new object each time the user selects a PR, which clears that PR's review folder
     * error so the folder is asked for again.
     */
    retry: Observable<Readonly<{key: string}> | undefined>;
}>()({
    tagName: 'vir-review-stage',
    state() {
        return {
            /**
             * Pull requests that have been selected, keyed like `activePullRequest`. Kept so
             * switching PRs keeps each one's AI pane alive.
             */
            reviewTargets: [] as ReadonlyArray<ReviewTarget>,
            /** Keys whose review folder has been asked for, so each is only asked for once. */
            requestedReviewKeys: [] as ReadonlyArray<string>,
            reviewFolderErrors: {} as Readonly<Record<string, string | undefined>>,
            handledRetryRequest: undefined as Readonly<{key: string}> | undefined,
        };
    },
    styles: css`
        :host {
            display: block;
            position: absolute;
            inset: 0;
        }

        .stage-empty {
            display: flex;
            align-items: center;
            justify-content: center;
            color: ${viraThemeByKeys.grey.foreground.placeholder.foreground.value};
            font-size: 13px;
            height: 100%;
        }

        .stage-error {
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            z-index: 1;
            padding: 8px 12px;
            ${colorCss(viraTheme.colors[themeDefaultKey])};
            color: ${viraThemeByKeys.red.foreground.body.foreground.value};
            font-size: 13px;
        }

        .pane-slot {
            position: absolute;
            inset: 0;
            display: none;
        }

        .pane-slot[data-active] {
            display: block;
        }
    `,
    render({inputs, state, updateState, host}) {
        const isMobile = inputs.context.screenSize === ScreenSize.Mobile;

        const unhandledRetryRequest =
            inputs.retry.value === state.handledRetryRequest ? undefined : inputs.retry.value;
        const reviewFolderErrors: Readonly<Record<string, string | undefined>> =
            unhandledRetryRequest
                ? omitObjectKeys(state.reviewFolderErrors, [unhandledRetryRequest.key])
                : state.reviewFolderErrors;
        if (unhandledRetryRequest) {
            updateState({
                handledRetryRequest: unhandledRetryRequest,
                reviewFolderErrors,
            });
        }

        if (
            !inputs.context.isInActivityTab &&
            inputs.activePullRequest &&
            inputs.activePullRequest !== reviewMemory.selectedPullRequest.read()
        ) {
            reviewMemory.selectedPullRequest.write(inputs.activePullRequest);
        }

        const reviewRoutePaths = check.isLengthExactly(inputs.subPaths, 3)
            ? inputs.subPaths
            : undefined;

        /**
         * Create the PR's review folder before its pane group mounts, since the AI pane opens into
         * it. Deferred via a microtask so we don't mutate during render.
         */
        if (
            reviewRoutePaths &&
            inputs.reviewQueueKeys &&
            inputs.activePullRequest &&
            !state.requestedReviewKeys.includes(inputs.activePullRequest) &&
            !reviewFolderErrors[inputs.activePullRequest]
        ) {
            const key = inputs.activePullRequest;
            const [
                owner,
                repoName,
                prNumber,
            ] = reviewRoutePaths;
            void Promise.resolve().then(async () => {
                updateState({
                    requestedReviewKeys: [
                        ...host.instanceState.requestedReviewKeys,
                        key,
                    ],
                });
                try {
                    const reviewFolder = await fetchApi(
                        gitHubReviewFolderEndpoint,
                        HttpMethod.Post,
                        {
                            requestData: {
                                owner,
                                repoName,
                                number: Number(prNumber),
                                /**
                                 * The folder is only a `mkdir` here, and its pane group's AI tab
                                 * opens into it.
                                 */
                                createFolder: true,
                            },
                        },
                    );
                    const isStarted =
                        !!reviewFolder.review &&
                        reviewFolder.review.status !== ManualReviewStatus.Aborted;
                    updateState({
                        reviewTargets: [
                            ...host.instanceState.reviewTargets.filter(
                                (target) => target.key !== key,
                            ),
                            {
                                key,
                                folder: reviewFolder.folder,
                                pullRequest: reviewFolder.pullRequest,
                            },
                        ],
                    });
                    /**
                     * A PR the viewer already reviewed opens on its Review pane, which shows what
                     * happened since, and so does one not started yet, for its Start button.
                     * Otherwise a started review's first visit opens on its diff.
                     */
                    const uiLayout = host.instanceInputs.context.uiLayout;
                    const openingTab =
                        reviewFolder.pullRequest.hasViewerReviewed || !isStarted
                            ? reviewPaneId
                            : uiLayout.value.layout?.tabLayouts[reviewFolder.folder]
                              ? undefined
                              : diffPaneId;
                    if (openingTab) {
                        uiLayout.showPaneTab({
                            folder: reviewFolder.folder,
                            kind: openingTab,
                        });
                    }
                } catch (error) {
                    /** Selecting the PR again clears the error, which retries. */
                    updateState({
                        requestedReviewKeys: host.instanceState.requestedReviewKeys.filter(
                            (requestedKey) => requestedKey !== key,
                        ),
                        reviewFolderErrors: {
                            ...host.instanceState.reviewFolderErrors,
                            [key]: extractErrorMessage(error),
                        },
                    });
                }
            });
        }

        /**
         * On mobile only the active PR's pane group mounts, since each one holds live `/pty`
         * sockets. A PR that left the queue unmounts too: the server kills its panes, so there's
         * nothing left to keep alive.
         */
        const renderedReviewTargets = state.reviewTargets.filter((target) => {
            return isMobile
                ? target.key === inputs.activePullRequest
                : !inputs.reviewQueueKeys || inputs.reviewQueueKeys.includes(target.key);
        });

        return html`
            ${inputs.activePullRequest && reviewFolderErrors[inputs.activePullRequest]
                ? html`
                      <div class="stage-error">${reviewFolderErrors[inputs.activePullRequest]}</div>
                  `
                : nothing}
            ${inputs.activePullRequest &&
            !reviewFolderErrors[inputs.activePullRequest] &&
            !state.reviewTargets.some((target) => target.key === inputs.activePullRequest)
                ? html`
                      <div class="stage-empty">Opening…</div>
                  `
                : nothing}
            ${inputs.activePullRequest
                ? nothing
                : html`
                      <div class="stage-empty">Select a pull request.</div>
                  `}
            ${repeat(
                renderedReviewTargets,
                (target) => target.key,
                (target) => {
                    const active = target.key === inputs.activePullRequest;
                    return html`
                        <div class="pane-slot" ?data-active=${active}>
                            <${VirPaneGroup.assign({
                                context: inputs.context,
                                folder: target.folder,
                                active: active && inputs.isShown,
                                extensionInputs: createReviewExtensionInputs(target.pullRequest),
                            })}></${VirPaneGroup}>
                        </div>
                    `;
                },
            )}
        `;
    },
});
