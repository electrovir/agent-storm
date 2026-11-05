import {PaneKind, type ReviewQueuePr} from '@agent-storm/common';
import {css, defineElementEvent, html, listen, nothing} from 'element-vir';
import {type AppContext} from '../../util/app-context.js';
import {createFolderSessions, type FolderSessionsObservable} from '../../util/folder-sessions.js';
import {localStorageClient} from '../../util/local-storage-client.js';
import {DiffView, resolveDiffView, resolvePaneLayout} from '../../util/pane-layout.js';
import {paneRestartKey} from '../../util/pane-restarts.js';
import {
    createPaneReview,
    type PaneReviewObservable,
    type ReviewStart,
} from '../../util/pane-review.js';
import {selectPaneTab, sessionIndexFromRoute, tabFromRoute} from '../../util/router.js';
import {ScreenSize} from '../../util/screen-size.js';
import {defineAppElement} from '../define-app-element.js';
import {VirPaneDiff} from './vir-pane-diff.element.js';
import {VirPaneHeader} from './vir-pane-header.element.js';
import {VirPaneReview} from './vir-pane-review.element.js';
import {VirPaneSplit} from './vir-pane-split.element.js';
import {VirReviewPane} from './vir-review-pane.element.js';
import {VirSessionPane} from './vir-session-pane.element.js';

/** A folder's panes: AI and Shell terminals, its diff, and its PR's review. */
export const VirPaneGroup = defineAppElement<{
    folder: string;
    /**
     * What the pane tab and session tabs are remembered under. A review is keyed by its PR because
     * its folder isn't known until the server resolves it.
     */
    memoryKey: string;
    /** True when this pane-group is the user's currently focused folder. */
    active: boolean;
    context: AppContext;
    /**
     * Set when the folder is a pull request's review folder. Swaps the shell pane for the review
     * UI, and holds the Diff tab back until the manual review's startup has finished.
     */
    reviewPullRequest?: Readonly<ReviewQueuePr> | undefined;
    /** Typed into the AI pane once its first session loads, unless it's already been sent. */
    reviewStart?: Readonly<ReviewStart> | undefined;
}>()({
    tagName: 'vir-pane-group',
    events: {
        /** The parent should set the `reviewStart` it passed in as sent. */
        reviewStartSent: defineElementEvent<void>(),
    },
    state() {
        return {
            /** Created in `init`, which has the folder. */
            folderSessions: undefined as FolderSessionsObservable | undefined,
            paneReview: undefined as PaneReviewObservable | undefined,
            /**
             * The last pane to receive focus, rather than `:focus-within`, which xterm's hidden
             * textarea loses on a cmd+tab away and back. Defaults to the AI pane so the initial
             * render doesn't show both panes dimmed.
             */
            focusedKind: PaneKind.Ai as PaneKind,
            /**
             * Set the first time the Diff tab opens. The diff costs nothing while hidden (no
             * socket, no subprocess), so staying mounted keeps its selected file and scroll
             * position.
             */
            diffMounted: false,
            /** Which checkout a Build folder's Diff tab shows. */
            diffView: DiffView.Source as DiffView,
            /** Keeps the Diff tab on the manual review while its copy is still being made. */
            isManualReviewStarting: false,
        };
    },
    init({inputs, updateState}) {
        const folderSessions = createFolderSessions(inputs.folder);
        updateState({
            folderSessions,
            paneReview: createPaneReview({
                folder: inputs.folder,
                memoryKey: inputs.memoryKey,
                folderSessions,
            }),
            diffView:
                localStorageClient.diffViewByFolder.readFolder(inputs.folder) ?? DiffView.Source,
        });
    },
    cleanup({state}) {
        state.folderSessions?.destroy();
        state.paneReview?.destroy();
    },
    styles: css`
        :host {
            display: flex;
            flex-direction: column;
            width: 100%;
            height: 100%;
        }

        .body {
            display: flex;
            flex-direction: row;
            flex-grow: 1;
            flex-shrink: 1;
            min-height: 0;
            width: 100%;
            position: relative;
        }
    `,
    render({inputs, state, updateState, dispatch, events}) {
        const {folderSessions, paneReview} = state;
        if (!folderSessions || !paneReview) {
            return '';
        }
        const info = inputs.context.folderData.value.folderInfo.get(inputs.folder);
        const isMobile = inputs.context.screenSize === ScreenSize.Mobile;
        const hasPr = !!info?.prUrl;
        const layout = resolvePaneLayout({
            activeTab: tabFromRoute(inputs.context.route),
            isMobile,
            isReviewFolder: !!inputs.reviewPullRequest,
            hasPr,
            review: paneReview.value.review,
        });

        if (layout.isDiffTab && !state.diffMounted) {
            updateState({
                diffMounted: true,
            });
        }
        folderSessions.sync(info?.sessionStatuses || []);
        paneReview.sync({
            active: inputs.active,
            hasPr,
            isPrNeeded: layout.isDiffTab || layout.isReviewPaneTab,
            isReviewPaneOpen: layout.isReviewPaneTab && inputs.active,
            isDiffMounted: state.diffMounted,
            reviewPullRequest: inputs.reviewPullRequest,
            frontendState: inputs.context.frontendState,
        });

        const diff = resolveDiffView({
            chosen: state.diffView,
            hasChanges: !!info?.git.dirty,
            reviewCopyFolder: paneReview.value.reviewCopyFolder,
            review: paneReview.value.review,
            isManualReviewStarting: state.isManualReviewStarting,
        });
        if (state.isManualReviewStarting && diff.isAvailable[DiffView.ManualReview]) {
            updateState({
                isManualReviewStarting: false,
            });
        }

        if (
            inputs.reviewStart &&
            paneReview.sendReviewStart({
                reviewStart: inputs.reviewStart,
                isMobile,
            })
        ) {
            dispatch(
                new events.reviewStartSent({
                    detail: undefined,
                }),
            );
        }

        const sessionPaneInputs = {
            folder: inputs.folder,
            memoryKey: inputs.memoryKey,
            folderSessions,
            active: inputs.active,
            isMobile,
            sessionStatuses: info?.sessionStatuses || [],
        };

        return html`
            <${VirPaneHeader.assign({
                folder: inputs.folder,
                isMobile,
                tabButtons: layout.tabButtons,
                diffViewPicker:
                    layout.isDiffTab && !inputs.reviewPullRequest
                        ? {
                              selected: diff.diffView,
                              isSelectable: {
                                  [DiffView.Source]: diff.isAvailable[DiffView.Source],
                                  [DiffView.ManualReview]: diff.isManualReviewSelectable,
                              },
                          }
                        : undefined,
            })}
                ${listen(VirPaneHeader.events.tabRequested, (event) => {
                    selectPaneTab({
                        memoryKey: inputs.memoryKey,
                        tab: event.detail,
                    });
                })}
                ${listen(VirPaneHeader.events.diffViewSelected, (event) => {
                    localStorageClient.diffViewByFolder.writeFolder({
                        folder: inputs.folder,
                        value: event.detail,
                    });
                    updateState({
                        diffView: event.detail,
                        isManualReviewStarting: false,
                    });
                })}
            ></${VirPaneHeader}>
            <div class="body">
                ${state.diffMounted
                    ? html`
                          <${VirPaneDiff.assign({
                              folder: inputs.folder,
                              isShown: layout.isDiffTab && inputs.active,
                              diffView: diff.diffView,
                              paneReview,
                              isReviewCopyReady: diff.isAvailable[DiffView.ManualReview],
                              isReviewFolder: !!inputs.reviewPullRequest,
                              frontendState: inputs.context.frontendState,
                              screenSize: inputs.context.screenSize,
                          })}></${VirPaneDiff}>
                      `
                    : nothing}
                <${VirPaneSplit.assign({
                    /**
                     * Review folders remember their own split, so resizing one leaves the other
                     * alone.
                     */
                    splitSetting: inputs.reviewPullRequest
                        ? localStorageClient.reviewPaneSplit
                        : localStorageClient.paneSplit,
                    isMobile,
                })}
                    ?data-hidden=${layout.isDiffTab}
                >
                    <${VirSessionPane.assign({
                        ...sessionPaneInputs,
                        kind: PaneKind.Ai,
                        sessionIndex: sessionIndexFromRoute(inputs.context.route, PaneKind.Ai),
                        mountTerminal: layout.mountAiTerminal,
                        folderRestartKey:
                            inputs.context.paneRestarts.value.keys[
                                paneRestartKey({
                                    folder: inputs.folder,
                                    kind: PaneKind.Ai,
                                })
                            ] || 0,
                        showError: true,
                        ai: {
                            folderAiId: info?.aiId || '',
                            parentRepoPath: info?.parentRepoPath || '',
                            aiConfigRevision: inputs.context.paneRestarts.value.aiConfigRevision,
                        },
                    })}
                        slot=${VirPaneSplit.slotNames['vir-pane-split-start']}
                        ?data-hidden=${!layout.showAiPane}
                        data-pane-focused=${state.focusedKind === PaneKind.Ai}
                        ${listen('focusin', () => {
                            updateState({
                                focusedKind: PaneKind.Ai,
                            });
                        })}
                    ></${VirSessionPane}>
                    <${VirSessionPane.assign({
                        ...sessionPaneInputs,
                        kind: PaneKind.Shell,
                        sessionIndex: sessionIndexFromRoute(inputs.context.route, PaneKind.Shell),
                        mountTerminal: layout.mountShellTerminal,
                        folderRestartKey:
                            inputs.context.paneRestarts.value.keys[
                                paneRestartKey({
                                    folder: inputs.folder,
                                    kind: PaneKind.Shell,
                                })
                            ] || 0,
                        showError: false,
                    })}
                        ?data-hidden=${!layout.showShellPane}
                        ?data-collapsed=${layout.isReviewPaneTab}
                        data-pane-focused=${state.focusedKind === PaneKind.Shell}
                        ${listen('focusin', () => {
                            updateState({
                                focusedKind: PaneKind.Shell,
                            });
                        })}
                    ></${VirSessionPane}>
                    ${layout.hasReviewTab
                        ? html`
                              <${VirPaneReview.assign({
                                  folder: inputs.folder,
                                  paneReview,
                                  frontendState: inputs.context.frontendState,
                                  isMobile,
                                  initialPromptSentAt: inputs.reviewStart?.reviewUpdatedAt,
                              })}
                                  ?data-hidden=${!layout.isReviewPaneTab}
                                  ?data-collapsed=${!layout.isReviewPaneTab}
                                  ${listen(VirReviewPane.events.manualReviewStarted, () => {
                                      if (!inputs.reviewPullRequest) {
                                          updateState({
                                              diffView: DiffView.ManualReview,
                                              isManualReviewStarting: true,
                                          });
                                      }
                                  })}
                              ></${VirPaneReview}>
                          `
                        : nothing}
                </${VirPaneSplit}>
            </div>
        `;
    },
});
