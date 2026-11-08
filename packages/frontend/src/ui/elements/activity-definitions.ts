import {html, type HtmlInterpolation} from 'element-vir';
import {type AppContext} from '../../util/app-context.js';
import {getShownPrQueues, PrQueueKind} from '../../util/frontend-state.js';
import {localStorageClient, type Setting} from '../../util/local-storage-client.js';
import {ActivityId} from '../../util/router.js';
import {VirBook} from './vir-book.element.js';
import {VirBuildSidebar} from './vir-build-sidebar.element.js';
import {VirBuildStage} from './vir-build-stage.element.js';
import {VirDashboard} from './vir-dashboard.element.js';
import {VirReviewQueueSidebar} from './vir-review-queue-sidebar.element.js';
import {VirReviewStage} from './vir-review-stage.element.js';

/** A list beside an activity's content that selects what the content shows. */
export type ActivitySidebar = Readonly<{
    /** Where the sidebar's width is stored. */
    widthSetting: Readonly<Setting<number>>;
    render(context: AppContext): HtmlInterpolation;
}>;

/** One vertical tab and everything it shows. */
export type ActivityDefinition = Readonly<{
    label: string;
    /** Shown after the label once known, like the number of PRs waiting on review. */
    findCount(context: AppContext): number | undefined;
    isShown(context: AppContext): boolean;
    /**
     * Titles the mobile modal that holds the activity strip and the sidebar. Undefined for an
     * activity that shows the strip inline on mobile instead.
     */
    mobileMenuTitle: string | undefined;
    /** Undefined for an activity whose content fills the whole area. */
    sidebar: ActivitySidebar | undefined;
    /**
     * Keeps the content mounted, hidden, while another activity shows, once it has shown once. Set
     * for content holding live terminals, which unmounting would tear down.
     */
    isKeptMounted: boolean;
    render(
        params: Readonly<{
            context: AppContext;
            isShown: boolean;
        }>,
    ): HtmlInterpolation;
}>;

export const activityDefinitions: Readonly<Record<ActivityId, ActivityDefinition>> = {
    [ActivityId.Dashboard]: {
        label: 'Dashboard',
        findCount() {
            return undefined;
        },
        isShown() {
            return true;
        },
        mobileMenuTitle: undefined,
        sidebar: undefined,
        isKeptMounted: false,
        render({context}) {
            return html`
                <${VirDashboard.assign({
                    context,
                    buildListHeading: activityDefinitions[ActivityId.Build].label,
                })}></${VirDashboard}>
            `;
        },
    },
    [ActivityId.Build]: {
        label: 'Build',
        findCount() {
            return undefined;
        },
        isShown() {
            return true;
        },
        mobileMenuTitle: 'Repos',
        sidebar: {
            widthSetting: localStorageClient.sidebarWidth,
            render(context) {
                return html`
                    <${VirBuildSidebar.assign({
                        context,
                    })}></${VirBuildSidebar}>
                `;
            },
        },
        isKeptMounted: true,
        render({context}) {
            return html`
                <${VirBuildStage.assign({
                    activeFolder: context.resolved.activeFolder?.path,
                    context,
                })}></${VirBuildStage}>
            `;
        },
    },
    [ActivityId.Review]: {
        label: 'Review',
        findCount(context) {
            const frontendState = context.frontendState?.value;
            return (
                frontendState &&
                getShownPrQueues(frontendState)[PrQueueKind.Review].queue?.pullRequests.length
            );
        },
        isShown() {
            return true;
        },
        mobileMenuTitle: 'Review requests',
        sidebar: {
            widthSetting: localStorageClient.reviewSidebarWidth,
            render(context) {
                return html`
                    <${VirReviewQueueSidebar.assign({
                        context,
                    })}></${VirReviewQueueSidebar}>
                `;
            },
        },
        isKeptMounted: true,
        render({context, isShown}) {
            return html`
                <${VirReviewStage.assign({
                    context,
                    activePullRequest: context.resolved.activePullRequest,
                    reviewQueueKeys: context.resolved.reviewQueueKeys,
                    isShown,
                    retryRequest: context.reviewRetry.value,
                })}></${VirReviewStage}>
            `;
        },
    },
    [ActivityId.Debug]: {
        label: 'Debug',
        findCount() {
            return undefined;
        },
        isShown(context) {
            return context.isDebugTabShown;
        },
        mobileMenuTitle: 'Debug',
        sidebar: undefined,
        isKeptMounted: false,
        render({context}) {
            return html`
                <${VirBook.assign({
                    routeBase: ActivityId.Debug,
                    subPaths: context.route.paths.slice(1),
                })}></${VirBook}>
            `;
        },
    },
};
