import {html, listen, type HtmlInterpolation} from 'element-vir';
import {activityInfo} from '../../util/activity-info.js';
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

/** Everything one activity shows. Its label and default visibility are in `activityInfo`. */
export type ActivityDefinition = Readonly<{
    /** Shown after the label once known, like the number of PRs waiting on review. */
    findCount(context: AppContext): number | undefined;
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
        findCount() {
            return undefined;
        },
        mobileMenuTitle: undefined,
        sidebar: undefined,
        isKeptMounted: false,
        render({context}) {
            return html`
                <${VirDashboard.assign({
                    context,
                    buildListHeading: activityInfo[ActivityId.Build].label,
                })}></${VirDashboard}>
            `;
        },
    },
    [ActivityId.Build]: {
        findCount() {
            return undefined;
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
        findCount(context) {
            const frontendState = context.frontendState?.value;
            return (
                frontendState &&
                getShownPrQueues(frontendState)[PrQueueKind.Review].queue?.pullRequests.length
            );
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
        findCount() {
            return undefined;
        },
        mobileMenuTitle: 'Debug',
        sidebar: undefined,
        isKeptMounted: false,
        render({context}) {
            return html`
                <${VirBook.assign({
                    routeBase: ActivityId.Debug,
                    subPaths: context.route.paths.slice(1),
                })}
                    ${listen(VirBook.events.routeChange, (event) => {
                        context.navigate(event.detail);
                    })}
                ></${VirBook}>
            `;
        },
    },
};
