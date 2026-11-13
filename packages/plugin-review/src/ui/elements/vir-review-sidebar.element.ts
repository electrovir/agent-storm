import {type ReviewQueuePr} from '@agent-storm/common';
import {
    createSettingsTarget,
    defineAppElement,
    restartFolderPanes,
    VirSidebarRepoHeader,
    VirSidebarSearch,
    type PaneRestartedEvent,
    type SettingsTarget,
} from '@agent-storm/core/frontend';
import {extractErrorMessage} from '@augment-vir/common';
import {colorCss} from '@electrovir/color';
import {css, defineElementEvent, html, listen, nothing, repeat} from 'element-vir';
import {ViraCollapsibleCard, viraThemeByKeys} from 'vira';
import {PrQueueKind, pullRequestRouteKey} from '../../util/pr-queues.js';
import {type ReviewedRepo} from '../../util/pr-reviews.js';
import {reviewClient} from '../../util/review-client.js';
import {reviewSettingsSection} from './review-settings-section.js';
import {
    filterPullRequestsBySearch,
    groupByRepo,
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
            searchQuery: '',
            openMenuRepo: undefined as string | undefined,
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
        const isSearching = !!state.searchQuery.trim();
        const pullRequests = filterPullRequestsBySearch(
            shownQueue?.queue?.pullRequests || [],
            state.searchQuery,
        );
        const reviewedPullRequests = filterPullRequestsBySearch(
            (selectedQueue === PrQueueKind.Review && shownQueue?.queue?.reviewedPullRequests) || [],
            state.searchQuery,
        );
        /** Enter opens the top row as rendered, so it follows the repo grouping. */
        const firstSearchResult = isSearching
            ? (groupByRepo(pullRequests)[0]?.pullRequests[0] ??
              groupByRepo(reviewedPullRequests)[0]?.pullRequests[0])
            : undefined;

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
                const reviewFolder = await reviewClient.call('resolveReviewFolder', {
                    owner: pr.owner,
                    repoName: pr.repoName,
                    number: pr.number,
                    createFolder: false,
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

        function renderRepoGroups(pullRequests: ReadonlyArray<ReviewQueuePr>) {
            return repeat(
                groupByRepo(pullRequests),
                (group) => group.repo,
                (group) => {
                    return html`
                        <${VirSidebarRepoHeader.assign({
                            name: group.repo,
                            count: group.pullRequests.length,
                            isMenuOpen: state.openMenuRepo === group.repo,
                            mobileModal: inputs.mobileModal,
                            menuEntries: [
                                {
                                    content: 'Settings',
                                    onClick() {
                                        openInitCmdSettings(group);
                                    },
                                },
                            ],
                        })}
                            ${listen(VirSidebarRepoHeader.events.menuOpenChange, (event) => {
                                updateState({
                                    openMenuRepo: event.detail ? group.repo : undefined,
                                });
                            })}
                        ></${VirSidebarRepoHeader}>
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
                                        /**
                                         * The server stacks PRs across the whole queue, so a parent
                                         * can be filtered out of the shown list.
                                         */
                                        isUnderParent:
                                            !!pr.chainDepth &&
                                            group.pullRequests.some((other) => {
                                                return other.branchName === pr.baseBranchName;
                                            }),
                                        mobileModal: inputs.mobileModal,
                                    })}
                                        data-sidebar-search-result
                                        ${listen(VirReviewSidebarRow.events.rowClicked, (event) => {
                                            activatePullRequest(event.detail);
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
                  ${pullRequests.length
                      ? renderRepoGroups(pullRequests)
                      : html`
                            <div class="empty">
                                ${isSearching
                                    ? 'No matching pull requests.'
                                    : prQueueTabs[selectedQueue].emptyMessage}
                            </div>
                        `}
                  ${reviewedPullRequests.length
                      ? html`
                            <${ViraCollapsibleCard.assign({
                                rawCollapsible: true,
                                /** A match hidden in a collapsed section reads as no match. */
                                startExpanded: state.isReviewedExpanded || isSearching,
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
                                ${renderRepoGroups(reviewedPullRequests)}
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
                searchQuery: state.searchQuery,
                hasSearchResult: !!firstSearchResult,
            })}
                ${listen(VirSidebarSearch.events.searchQueryChange, (event) => {
                    updateState({
                        searchQuery: event.detail,
                    });
                })}
                ${listen(VirSidebarSearch.events.searchSubmit, () => {
                    if (firstSearchResult) {
                        activatePullRequest(firstSearchResult);
                    }
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
