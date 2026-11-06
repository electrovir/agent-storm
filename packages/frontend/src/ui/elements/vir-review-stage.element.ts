import {
    gitHubReviewFolderEndpoint,
    ManualReviewStatus,
    type ManualReviewState,
    type ReviewQueuePr,
} from '@agent-storm/common';
import {check} from '@augment-vir/assert';
import {extractErrorMessage, omitObjectKeys} from '@augment-vir/common';
import {colorCss} from '@electrovir/color';
import {HttpMethod} from '@rest-vir/api';
import {css, html, listen, nothing, repeat} from 'element-vir';
import {themeDefaultKey} from 'theme-vir';
import {viraTheme, viraThemeByKeys} from 'vira';
import {fetchApi} from '../../util/api-client.js';
import {type AppContext} from '../../util/app-context.js';
import {FrontendTab} from '../../util/frontend-tab.js';
import {localStorageClient} from '../../util/local-storage-client.js';
import {type ReviewStart} from '../../util/pane-review.js';
import {router} from '../../util/router.js';
import {ScreenSize} from '../../util/screen-size.js';
import {defineAppElement} from '../define-app-element.js';
import {VirPaneGroup} from './vir-pane-group.element.js';
import {VirReviewPane} from './vir-review-pane.element.js';

type ReviewTarget = {
    key: string;
    folder: string;
    pullRequest: ReviewQueuePr;
    /** As of selecting the PR. `VirPaneGroup` polls it once the review is open. */
    review: ManualReviewState | undefined;
    /**
     * Set once the review folder exists and should get its AI pane: on selecting a PR whose review
     * is underway, or on clicking Start Manual Review.
     */
    isOpen: boolean;
    start: ReviewStart | undefined;
};

/** The Review tab's stage: each selected pull request's review folder and its panes. */
export const VirReviewStage = defineAppElement<{
    context: AppContext;
    /** Keyed by `pullRequestRouteKey`. Only set for a PR that's still in a review queue. */
    activePullRequest: string | undefined;
    /** Undefined until the review queue has loaded. */
    reviewQueueKeys: ReadonlyArray<string> | undefined;
    isShown: boolean;
    /**
     * A new object each time the user selects a PR, which clears that PR's review folder error so
     * the folder is asked for again.
     */
    retryRequest: Readonly<{key: string}> | undefined;
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
            inputs.retryRequest === state.handledRetryRequest ? undefined : inputs.retryRequest;
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

        const localDbClient = inputs.context.frontendState?.value.localDbClient;
        if (
            localDbClient &&
            inputs.activePullRequest &&
            inputs.activePullRequest !== localDbClient.value.review?.selectedPullRequest
        ) {
            void localDbClient.set.review({
                ...localDbClient.value.review,
                selectedPullRequest: inputs.activePullRequest,
            });
        }

        const reviewRoutePaths = check.isLengthExactly(inputs.context.route.paths, 4)
            ? inputs.context.route.paths
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
                ,
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
                                createFolder: false,
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
                                ...reviewFolder,
                                review: reviewFolder.review ?? undefined,
                                isOpen: isStarted,
                                start: undefined,
                            },
                        ],
                    });
                    /**
                     * A PR the viewer already reviewed opens on its Review pane, which shows what
                     * happened since. Otherwise a started review's first visit opens on its diff
                     * instead of the AI pane.
                     */
                    const openingTab = reviewFolder.pullRequest.hasViewerReviewed
                        ? host.instanceInputs.context.screenSize === ScreenSize.Mobile
                            ? FrontendTab.Review
                            : FrontendTab.Ai
                        : isStarted && localStorageClient.tabByFolder.readFolder(key) == undefined
                          ? FrontendTab.Diff
                          : undefined;
                    if (openingTab) {
                        localStorageClient.tabByFolder.writeFolder({
                            folder: key,
                            value: openingTab,
                        });
                        const currentRoute = host.instanceInputs.context.route;
                        if (
                            currentRoute.paths.slice(1).join('/') === key &&
                            (reviewFolder.pullRequest.hasViewerReviewed ||
                                !currentRoute.search?.tab)
                        ) {
                            router.setRoute(
                                {
                                    paths: currentRoute.paths,
                                    search: {
                                        ...currentRoute.search,
                                        tab: [
                                            openingTab,
                                        ],
                                    },
                                },
                                {
                                    replace: true,
                                },
                            );
                        }
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

        async function startReview({
            target,
            prompt,
            isStart,
        }: Readonly<{
            target: Readonly<ReviewTarget>;
            prompt: string;
            /** False for a verdict or Reset, which don't need a fresh checkout's init command. */
            isStart: boolean;
        }>) {
            updateState({
                reviewFolderErrors: omitObjectKeys(host.instanceState.reviewFolderErrors, [
                    target.key,
                ]),
            });
            try {
                await fetchApi(gitHubReviewFolderEndpoint, HttpMethod.Post, {
                    requestData: {
                        owner: target.pullRequest.owner,
                        repoName: target.pullRequest.repoName,
                        number: target.pullRequest.number,
                        createFolder: true,
                    },
                });
                updateState({
                    reviewTargets: host.instanceState.reviewTargets.map((existing) => {
                        return existing.key === target.key
                            ? {
                                  ...existing,
                                  isOpen: true,
                                  start: {
                                      prompt,
                                      reviewUpdatedAt: target.review?.lastUpdatedAt ?? 0,
                                      isStart,
                                      isSent: false,
                                  },
                              }
                            : existing;
                    }),
                });
            } catch (error) {
                updateState({
                    reviewFolderErrors: {
                        ...host.instanceState.reviewFolderErrors,
                        [target.key]: extractErrorMessage(error),
                    },
                });
            }
        }

        function markStartSent(key: string) {
            updateState({
                reviewTargets: host.instanceState.reviewTargets.map((target) => {
                    return target.key === key && target.start
                        ? {
                              ...target,
                              start: {
                                  ...target.start,
                                  isSent: true,
                              },
                          }
                        : target;
                }),
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
                            ${target.isOpen
                                ? html`
                                      <${VirPaneGroup.assign({
                                          context: inputs.context,
                                          folder: target.folder,
                                          memoryKey: target.key,
                                          active: active && inputs.isShown,
                                          reviewPullRequest: target.pullRequest,
                                          reviewStart: target.start,
                                      })}
                                          ${listen(VirPaneGroup.events.reviewStartSent, () => {
                                              markStartSent(target.key);
                                          })}
                                      ></${VirPaneGroup}>
                                  `
                                : html`
                                      <${VirReviewPane.assign({
                                          pullRequest: target.pullRequest,
                                          folder: target.folder,
                                          review: target.review,
                                          frontendState: inputs.context.frontendState,
                                      })}
                                          ${listen(
                                              VirReviewPane.events.verdictRequested,
                                              async (event) => {
                                                  await inputs.context.frontendState?.requestVerdict(
                                                      {
                                                          pullRequest: target.pullRequest,
                                                          verdict: event.detail,
                                                          sendPrompt(prompt) {
                                                              return startReview({
                                                                  target,
                                                                  prompt,
                                                                  isStart: false,
                                                              });
                                                          },
                                                      },
                                                  );
                                              },
                                          )}
                                          ${listen(
                                              VirReviewPane.events.manualReviewRequested,
                                              (event) => {
                                                  return startReview({
                                                      target,
                                                      ...event.detail,
                                                  });
                                              },
                                          )}
                                      ></${VirReviewPane}>
                                  `}
                        </div>
                    `;
                },
            )}
        `;
    },
});
