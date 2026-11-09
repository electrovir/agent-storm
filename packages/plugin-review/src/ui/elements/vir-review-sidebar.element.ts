import {gitHubReviewFolderEndpoint, type ReviewQueuePr} from '@agent-storm/common';
import {
    createSettingsTarget,
    defineAppElement,
    fetchApi,
    restartFolderPanes,
    type PaneRestartedEvent,
    type SettingsTarget,
} from '@agent-storm/core/frontend';
import {extractErrorMessage} from '@augment-vir/common';
import {colorCss} from '@electrovir/color';
import {HttpMethod} from '@rest-vir/api';
import {css, defineElementEvent, html, listen, nothing, repeat} from 'element-vir';
import {ViraCollapsibleCard, viraThemeByKeys} from 'vira';
import {PrQueueKind, pullRequestRouteKey} from '../../util/pr-queues.js';
import {type ReviewedRepo} from '../../util/pr-reviews.js';
import {reviewSettingsSection} from './review-settings-section.js';
import {
    groupByRepo,
    openOnGitHub,
    prQueueTabs,
    type ReviewSidebarQueues,
} from './review-sidebar-display.js';
import {VirReviewSidebarHeader} from './vir-review-sidebar-header.element.js';
import {VirReviewSidebarRow} from './vir-review-sidebar-row.element.js';
import {VirReviewSidebarSettingsMenu} from './vir-review-sidebar-settings-menu.element.js';

/**
 * The Review tab's sidebar: every open PR waiting on the `gh` account's review, or on the Assignee
 * tab every open PR assigned to it, grouped under its repo the way the Build sidebar groups
 * worktrees under their root. The viewer's own PRs open on GitHub; every other PR can be selected.
 */
export const VirReviewSidebar = defineAppElement<{
    /** {@link pullRequestRouteKey} of the selected PR. */
    activePullRequest: string | undefined;
    /** Undefined until the frontend state loads. */
    queues: ReviewSidebarQueues | undefined;
    /** Picking a list tab only emits `queueSelected`; the parent feeds the pick back in here. */
    selectedQueue?: PrQueueKind | undefined;
    /** Shows only this list, with its label beside the brand mark in place of the list tabs. */
    fixedQueue?: PrQueueKind | undefined;
    hideBorder?: boolean | undefined;
    mobileModal?: boolean | undefined;
}>()({
    tagName: 'vir-review-sidebar',
    events: {
        pullRequestActivated: defineElementEvent<ReviewQueuePr>(),
        refreshRequested: defineElementEvent<PrQueueKind>(),
        queueSelected: defineElementEvent<PrQueueKind>(),
        /** Emitted after a pane restart succeeds so the mounted terminal can reconnect. */
        paneRestarted: defineElementEvent<PaneRestartedEvent>(),
        /** The parent owns the Settings modal's open state. */
        settingsRequested: defineElementEvent<SettingsTarget>(),
    },
    state() {
        return {
            isReviewedExpanded: false,
            actionError: undefined as string | undefined,
        };
    },
    styles: css`
        :host {
            display: flex;
            flex-direction: column;
            height: 100%;
            font-size: 12px;
            border-right: 1px solid ${viraThemeByKeys.grey['behind-bg'].decoration.background.value};
        }

        :host([data-hide-border]) {
            border-right: none;
        }

        :host([data-mobile-modal]) {
            width: 100%;
            font-size: 15px;
        }

        .list {
            flex-grow: 1;
            min-height: 0;
            overflow-y: auto;
            overflow-x: hidden;
            padding: 4px 0 32px;
            font-size: 13px;
            font-weight: 300;
            letter-spacing: 0.01em;
        }

        .repo-header {
            padding: 6px 5px 2px;
            font-weight: 600;
            display: flex;
            justify-content: space-between;
            align-items: center;
            gap: 6px;

            /* The menu pops up inside the header, so it would inherit the repo name's bold. */
            & ${VirReviewSidebarSettingsMenu} {
                font-weight: 300;
            }
        }

        .count {
            font-weight: 400;
            color: ${viraThemeByKeys.grey.foreground['non-body'].foreground.value};
        }

        .error {
            padding: 8px 5px;
            ${colorCss(viraThemeByKeys.red['behind-bg'].body)};
            border-bottom: 1px solid ${viraThemeByKeys.red['behind-bg'].decoration.background.value};
            white-space: pre-wrap;
        }

        .reviewed {
            ${ViraCollapsibleCard.cssVars['vira-collapsible-card-content-gap'].name}: 0;
            margin-top: 8px;
            border-top: 1px solid ${viraThemeByKeys.grey['behind-bg'].decoration.background.value};
        }

        .reviewed-header {
            padding: 6px 5px 2px;
            color: ${viraThemeByKeys.grey.foreground['non-body'].foreground.value};
        }

        .empty {
            padding: 16px 10px;
            color: ${viraThemeByKeys.grey.foreground.placeholder.foreground.value};
            text-align: center;
        }

        :host([data-mobile-modal]) .list {
            font-size: 16px;
        }

        :host([data-mobile-modal]) .repo-header {
            padding: 10px 16px 4px;
        }
    `,
    render({inputs, state, updateState, host, dispatch, events}) {
        if (inputs.hideBorder) {
            host.setAttribute('data-hide-border', '');
        } else {
            host.removeAttribute('data-hide-border');
        }
        if (inputs.mobileModal) {
            host.setAttribute('data-mobile-modal', '');
        } else {
            host.removeAttribute('data-mobile-modal');
        }

        const selectedQueue = inputs.fixedQueue || inputs.selectedQueue || PrQueueKind.Review;
        const shownQueue = inputs.queues?.[selectedQueue];
        function activatePullRequest(pr: Readonly<ReviewQueuePr>) {
            dispatch(
                new events.pullRequestActivated({
                    detail: pr,
                }),
            );
        }
        const rowClickHandlers: Record<PrQueueKind, (pr: ReviewQueuePr) => void> = {
            [PrQueueKind.Review]: activatePullRequest,
            [PrQueueKind.Assignee](pr) {
                if (pr.isViewerAuthor) {
                    openOnGitHub(pr);
                } else {
                    activatePullRequest(pr);
                }
            },
        };

        const reviewedPullRequests =
            (selectedQueue === PrQueueKind.Review && shownQueue?.queue?.reviewedPullRequests) || [];

        const errorMessage = state.actionError || shownQueue?.loadError || shownQueue?.queue?.error;

        function openInitCmdSettings(repo: Readonly<ReviewedRepo> | undefined) {
            dispatch(
                new events.settingsRequested({
                    detail: createSettingsTarget({
                        section: reviewSettingsSection,
                        details: repo && {
                            owner: repo.owner,
                            repoName: repo.repoName,
                        },
                    }),
                }),
            );
        }

        async function restartPullRequestPanes(pr: Readonly<ReviewQueuePr>) {
            updateState({
                actionError: undefined,
            });
            function onError(error: unknown) {
                updateState({
                    actionError: extractErrorMessage(error),
                });
            }
            try {
                const reviewFolder = await fetchApi(gitHubReviewFolderEndpoint, HttpMethod.Post, {
                    requestData: {
                        owner: pr.owner,
                        repoName: pr.repoName,
                        number: pr.number,
                        createFolder: false,
                    },
                });
                await restartFolderPanes({
                    folder: reviewFolder.folder,
                    emitPaneRestarted(detail) {
                        dispatch(
                            new events.paneRestarted({
                                detail,
                            }),
                        );
                    },
                    onError,
                });
            } catch (error: unknown) {
                onError(error);
            }
        }

        function renderRepoGroups({
            pullRequests,
            openRow,
            canRestartPanes,
        }: Readonly<{
            pullRequests: ReadonlyArray<ReviewQueuePr>;
            openRow: (pr: ReviewQueuePr) => void;
            canRestartPanes: boolean;
        }>) {
            return repeat(
                groupByRepo(pullRequests),
                (group) => group.repo,
                (group) => {
                    return html`
                        <div class="repo-header">
                            <span>
                                ${group.repo}
                                <span class="count">(${group.pullRequests.length})</span>
                            </span>
                            <${VirReviewSidebarSettingsMenu.assign({
                                menuTitle: 'Repo actions',
                                repo: group,
                                mobileModal: inputs.mobileModal,
                            })}
                                ${listen(
                                    VirReviewSidebarSettingsMenu.events.settingsRequested,
                                    (event) => {
                                        openInitCmdSettings(event.detail);
                                    },
                                )}
                            ></${VirReviewSidebarSettingsMenu}>
                        </div>
                        ${repeat(
                            group.pullRequests,
                            (pr) => pullRequestRouteKey(pr),
                            (pr) => {
                                return html`
                                    <${VirReviewSidebarRow.assign({
                                        pr,
                                        queueKind: selectedQueue,
                                        isActive:
                                            pullRequestRouteKey(pr) === inputs.activePullRequest,
                                        canRestartPanes,
                                        mobileModal: inputs.mobileModal,
                                    })}
                                        ${listen(VirReviewSidebarRow.events.rowClicked, (event) => {
                                            openRow(event.detail);
                                        })}
                                        ${listen(
                                            VirReviewSidebarRow.events.restartPanesRequested,
                                            async (event) => {
                                                await restartPullRequestPanes(event.detail);
                                            },
                                        )}
                                    ></${VirReviewSidebarRow}>
                                `;
                            },
                        )}
                    `;
                },
            );
        }

        const listContents = shownQueue?.queue?.updatedAt
            ? html`
                  ${shownQueue.queue.pullRequests.length
                      ? renderRepoGroups({
                            pullRequests: shownQueue.queue.pullRequests,
                            openRow: rowClickHandlers[selectedQueue],
                            canRestartPanes: true,
                        })
                      : html`
                            <div class="empty">${prQueueTabs[selectedQueue].emptyMessage}</div>
                        `}
                  ${reviewedPullRequests.length
                      ? html`
                            <${ViraCollapsibleCard.assign({
                                rawCollapsible: true,
                                startExpanded: state.isReviewedExpanded,
                            })}
                                class="reviewed"
                                ${listen(ViraCollapsibleCard.events.expandToggle, (event) => {
                                    updateState({
                                        isReviewedExpanded: event.detail,
                                    });
                                })}
                            >
                                <div
                                    class="reviewed-header"
                                    slot=${ViraCollapsibleCard.slotNames[
                                        'vira-collapsible-card-header'
                                    ]}
                                >
                                    Already reviewed
                                    <span class="count">(${reviewedPullRequests.length})</span>
                                </div>
                                ${renderRepoGroups({
                                    pullRequests: reviewedPullRequests,
                                    /** The app only opens PRs still waiting on the viewer's review. */
                                    openRow: openOnGitHub,
                                    canRestartPanes: false,
                                })}
                            </${ViraCollapsibleCard}>
                        `
                      : nothing}
              `
            : errorMessage
              ? nothing
              : html`
                    <div class="empty">Loading…</div>
                `;

        return html`
            <${VirReviewSidebarHeader.assign({
                queues: inputs.queues,
                selectedQueue,
                fixedQueue: inputs.fixedQueue,
                mobileModal: inputs.mobileModal,
            })}
                ${listen(VirReviewSidebarHeader.events.refreshRequested, (event) => {
                    event.stopImmediatePropagation();
                    dispatch(
                        new events.refreshRequested({
                            detail: event.detail,
                        }),
                    );
                })}
                ${listen(VirReviewSidebarHeader.events.queueSelected, (event) => {
                    event.stopImmediatePropagation();
                    dispatch(
                        new events.queueSelected({
                            detail: event.detail,
                        }),
                    );
                })}
                ${listen(VirReviewSidebarSettingsMenu.events.settingsRequested, (event) => {
                    openInitCmdSettings(event.detail);
                })}
            ></${VirReviewSidebarHeader}>
            ${errorMessage
                ? html`
                      <div class="error">${errorMessage}</div>
                  `
                : nothing}
            <div class="list">${listContents}</div>
        `;
    },
});
