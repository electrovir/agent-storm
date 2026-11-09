import {
    isActivityEnabled,
    PaneMounting,
    updateTabState,
    type PaneDefinition,
    type PaneRenderParams,
} from '@agent-storm/core/frontend';
import {createSizedIcon, LucideAppWindowIcon} from 'vira';

function renderActivity(params: PaneRenderParams) {
    return params.context.renderActivityTab({
        paths: params.paneState.activityPaths,
        navigate(paths) {
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

/** A tab showing a whole activity, with its own selection apart from its vertical tab's. */
export const activityPane: PaneDefinition = {
    id: 'activity',
    label({tabState, context}) {
        const activityId = tabState?.activityPaths?.[0];
        return (
            context.activities.find((activity) => activity.id === activityId)?.label || 'Activity'
        );
    },
    newTabEntries(view) {
        return view.context.activities
            .filter((activity) => isActivityEnabled(view.context, activity))
            .map((activity) => {
                return {
                    label: activity.label,
                    state: {
                        activityPaths: [
                            activity.id,
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
};
