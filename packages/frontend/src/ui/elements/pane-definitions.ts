import {
    DiffView,
    ManualReviewStatus,
    PaneTabKind,
    type ManualReviewState,
    type PaneKind,
    type PaneState,
    type SessionMeta,
} from '@agent-storm/common';
import {check} from '@augment-vir/assert';
import {getEnumValues} from '@augment-vir/common';
import {html, listen, type HtmlInterpolation} from 'element-vir';
import {
    createSizedIcon,
    LucideAppWindowIcon,
    LucideBotIcon,
    LucideFileDiffIcon,
    LucideScanEyeIcon,
    LucideSquareTerminalIcon,
    ViraDropdown,
    type ViraIconSvg,
} from 'vira';
import {activityInfo, isActivityEnabled} from '../../util/activity-info.js';
import {type AppContext} from '../../util/app-context.js';
import {isNewTabShortcut} from '../../util/keyboard-shortcuts.js';
import {resolveDiffView} from '../../util/pane-layout.js';
import {type PaneReviewObservable, type ReviewStart} from '../../util/pane-review.js';
import {activityIdFromRoute, bareActivityPaths, orderedActivityIds} from '../../util/router.js';
import {
    addTab,
    createTabId,
    findShownTabIdOfKind,
    findTabGroupId,
    updateTabState,
    type TabLayout,
} from '../../util/tab-layout.js';
import {VirPaneDiff} from './vir-pane-diff.element.js';
import {VirPaneReview} from './vir-pane-review.element.js';
import {VirReviewPane} from './vir-review-pane.element.js';
import {VirTerminal} from './vir-terminal.element.js';

/** When a pane group renders a tab's pane. */
export enum PaneMounting {
    /** Only while the tab is on screen. */
    WhileDisplayed = 'whileDisplayed',
    /** From the first time the tab is on screen, so it keeps its scroll position and selection. */
    OnceDisplayed = 'onceDisplayed',
    /** Whenever the tab is in the layout. */
    Always = 'always',
}

/** A session tab's terminal session. */
export type SessionTab = Readonly<{
    kind: PaneKind;
    session: Readonly<SessionMeta>;
    /** How many sessions of this kind the folder has. */
    count: number;
}>;

/** What a pane group knows about itself and hands to each tab's pane. */
export type PaneGroupView = Readonly<{
    folder: string;
    context: AppContext;
    /** True when the pane group is the user's currently focused folder. */
    isActive: boolean;
    isMobile: boolean;
    isReviewFolder: boolean;
    layout: Readonly<TabLayout>;
    paneReview: PaneReviewObservable;
    review: Readonly<ManualReviewState> | undefined;
    reviewStart: Readonly<ReviewStart> | undefined;
    /** Keeps the Diff tab on the manual review while its copy is still being made. */
    isManualReviewStarting: boolean;
    setManualReviewStarting(isManualReviewStarting: boolean): void;
    writeLayout(change: (current: Readonly<TabLayout>) => Readonly<TabLayout>): void;
    openNewTab(
        params: Readonly<{
            kind: PaneTabKind;
            groupId: string | undefined;
            state?: Readonly<Partial<PaneState>> | undefined;
        }>,
    ): Promise<void>;
    /** The session whose terminal grabs focus when it mounts. */
    sessionToFocus: string | undefined;
    focusedTabId: string | undefined;
}>;

/** One tab's pane, as its definition renders it. */
export type PaneRenderParams = PaneGroupView &
    Readonly<{
        tabId: string;
        kind: PaneTabKind;
        /** The pane group's values, with the tab's own state over them. */
        paneState: Readonly<PaneState>;
        isDisplayed: boolean;
        /** Set for a session kind's tab, once its session exists. */
        sessionTab: SessionTab | undefined;
    }>;

/** One entry in the new-tab menu. */
export type NewTabEntry = Readonly<{
    label: string;
    /** The new tab's own state. */
    state: Readonly<Partial<PaneState>> | undefined;
}>;

/** One kind of pane a pane group's tab can hold. */
export type PaneDefinition = Readonly<{
    /** Names a tab with no name of its own. */
    label(tabState: Readonly<Partial<PaneState>> | undefined): string;
    /** The kind's entries in the new-tab menu. */
    newTabEntries(view: PaneGroupView): ReadonlyArray<NewTabEntry>;
    icon: ViraIconSvg;
    /** Whether the pane runs an AI, which its tab shows and its menu can change. */
    hasAi: boolean;
    mounting: PaneMounting;
    isAvailable(view: PaneGroupView): boolean;
    render(params: PaneRenderParams): HtmlInterpolation;
}>;

/** Before a review folder's review branch exists, its diff is meaningless or empty. */
function isReviewFolderDiffAvailable(review: Readonly<ManualReviewState> | undefined) {
    return (
        !!review &&
        review.status !== ManualReviewStatus.Aborted &&
        !(review.status === ManualReviewStatus.Started && review.isPending)
    );
}

const diffViewLabels: Readonly<Record<DiffView, string>> = {
    [DiffView.Source]: 'Source',
    [DiffView.ManualReview]: 'Manual review',
};

function renderTerminal(params: PaneRenderParams) {
    if (!params.sessionTab) {
        return '';
    }
    const sessionTab = params.sessionTab;
    return html`
        <${VirTerminal.assign({
            folder: params.folder,
            kind: sessionTab.kind,
            sessionId: sessionTab.session.id,
            active: params.isActive,
            showAccessoryKeys: params.isMobile,
            focusOnMount: params.sessionToFocus === sessionTab.session.id,
            isFocused: params.focusedTabId === params.tabId,
        })}
            ${listen('keydown', async (event) => {
                if (isNewTabShortcut(event)) {
                    event.preventDefault();
                    await params.openNewTab({
                        kind: params.kind,
                        groupId: findTabGroupId(params.layout, params.tabId),
                    });
                }
            })}
        ></${VirTerminal}>
    `;
}

function renderDiff(params: PaneRenderParams) {
    const info = params.context.folderData.value.folderInfo.get(params.folder);
    const diff = resolveDiffView({
        chosen: params.paneState.diffView,
        hasChanges: !!info?.git.dirty,
        reviewCopyFolder: params.paneReview.value.reviewCopyFolder,
        review: params.review,
        isManualReviewStarting: params.isManualReviewStarting,
    });
    if (params.isManualReviewStarting && diff.isAvailable[DiffView.ManualReview]) {
        params.setManualReviewStarting(false);
    }
    const isViewSelectable: Readonly<Record<DiffView, boolean>> = {
        [DiffView.Source]: diff.isAvailable[DiffView.Source],
        [DiffView.ManualReview]: diff.isManualReviewSelectable,
    };

    return html`
        <${VirPaneDiff.assign({
            folder: params.paneState.selectedFolder,
            isShown: params.isDisplayed && params.isActive,
            diffView: diff.diffView,
            diffSelections: params.paneState.diffSelections,
            paneReview: params.paneReview,
            isReviewCopyReady: diff.isAvailable[DiffView.ManualReview],
            isReviewFolder: params.isReviewFolder,
            frontendState: params.context.frontendState,
            screenSize: params.context.screenSize,
            sourcePicker: html`
                <${ViraDropdown.assign({
                    options: getEnumValues(DiffView).map((view) => {
                        return {
                            value: view,
                            label: diffViewLabels[view],
                            disabled: !isViewSelectable[view],
                        };
                    }),
                    selected: [
                        diff.diffView,
                    ],
                })}
                    ${listen(ViraDropdown.events.selectedValuesChange, (event) => {
                        const view = event.detail[0];
                        if (check.isEnumValue(view, DiffView)) {
                            params.writeLayout((current) => {
                                return updateTabState(current, {
                                    tabId: params.tabId,
                                    state: {
                                        diffView: view,
                                    },
                                });
                            });
                            params.setManualReviewStarting(false);
                        }
                    })}
                ></${ViraDropdown}>
            `,
        })}
            ${listen(VirPaneDiff.events.diffSelectionChange, (event) => {
                params.writeLayout((current) => {
                    const diffSelections = current.tabs[params.tabId]?.state?.diffSelections;
                    return updateTabState(current, {
                        tabId: params.tabId,
                        state: {
                            diffSelections: {
                                ...diffSelections,
                                [event.detail.diffView]: {
                                    ...diffSelections?.[event.detail.diffView],
                                    ...event.detail.selection,
                                },
                            },
                        },
                    });
                });
            })}
        ></${VirPaneDiff}>
    `;
}

function renderReview(params: PaneRenderParams) {
    return html`
        <${VirPaneReview.assign({
            folder: params.folder,
            paneReview: params.paneReview,
            frontendState: params.context.frontendState,
            isMobile: params.isMobile,
            initialPromptSentAt: params.reviewStart?.reviewUpdatedAt,
        })}
            ${listen(VirReviewPane.events.manualReviewStarted, () => {
                if (params.isReviewFolder) {
                    return;
                }
                params.writeLayout((current) => {
                    const diffTabId =
                        findShownTabIdOfKind(current, PaneTabKind.Diff) ||
                        createTabId(PaneTabKind.Diff);
                    return updateTabState(
                        addTab(current, {
                            tab: {
                                id: diffTabId,
                                kind: PaneTabKind.Diff,
                            },
                            isBackground: true,
                        }),
                        {
                            tabId: diffTabId,
                            state: {
                                diffView: DiffView.ManualReview,
                            },
                        },
                    );
                });
                params.setManualReviewStarting(true);
            })}
        ></${VirPaneReview}>
    `;
}

function renderActivity(params: PaneRenderParams) {
    return params.context.renderActivityTab({
        paths: params.paneState.activityPaths,
        navigate(route) {
            const paths = route.paths;
            if (!paths) {
                return;
            }
            params.writeLayout((current) => {
                return updateTabState(current, {
                    tabId: params.tabId,
                    state: {
                        activityPaths: [
                            ...paths,
                        ],
                    },
                });
            });
        },
    });
}

/** Every pane a pane group's tab can hold. */
export const paneDefinitions: Readonly<Record<PaneTabKind, PaneDefinition>> = {
    [PaneTabKind.Ai]: {
        label() {
            return 'AI';
        },
        newTabEntries() {
            return [
                {
                    label: 'AI session',
                    state: undefined,
                },
            ];
        },
        icon: createSizedIcon(LucideBotIcon, 14),
        hasAi: true,
        mounting: PaneMounting.WhileDisplayed,
        isAvailable() {
            return true;
        },
        render: renderTerminal,
    },
    [PaneTabKind.Shell]: {
        label() {
            return 'Shell';
        },
        newTabEntries() {
            return [
                {
                    label: 'Shell',
                    state: undefined,
                },
            ];
        },
        icon: createSizedIcon(LucideSquareTerminalIcon, 14),
        hasAi: false,
        mounting: PaneMounting.WhileDisplayed,
        isAvailable() {
            return true;
        },
        render: renderTerminal,
    },
    [PaneTabKind.Diff]: {
        label() {
            return 'Diff';
        },
        newTabEntries() {
            return [
                {
                    label: 'Diff',
                    state: undefined,
                },
            ];
        },
        icon: createSizedIcon(LucideFileDiffIcon, 14),
        hasAi: false,
        /** The diff costs nothing while hidden (no socket, no subprocess). */
        mounting: PaneMounting.OnceDisplayed,
        isAvailable(view) {
            return !view.isReviewFolder || isReviewFolderDiffAvailable(view.review);
        },
        render: renderDiff,
    },
    [PaneTabKind.Review]: {
        label() {
            return 'Review';
        },
        newTabEntries() {
            return [
                {
                    label: 'Review',
                    state: undefined,
                },
            ];
        },
        icon: createSizedIcon(LucideScanEyeIcon, 14),
        hasAi: false,
        mounting: PaneMounting.Always,
        isAvailable() {
            return true;
        },
        render: renderReview,
    },
    [PaneTabKind.Activity]: {
        label(tabState) {
            return activityInfo[
                activityIdFromRoute({
                    paths: tabState?.activityPaths || [],
                })
            ].label;
        },
        newTabEntries(view) {
            return orderedActivityIds
                .filter((activityId) => isActivityEnabled(view.context, activityId))
                .map((activityId) => {
                    return {
                        label: activityInfo[activityId].label,
                        state: {
                            activityPaths: [
                                ...bareActivityPaths[activityId],
                            ],
                        },
                    };
                });
        },
        icon: createSizedIcon(LucideAppWindowIcon, 14),
        hasAi: false,
        /** The Build activity holds live terminals, which unmounting would tear down. */
        mounting: PaneMounting.OnceDisplayed,
        isAvailable(view) {
            return !view.context.isInActivityTab;
        },
        render: renderActivity,
    },
};
