import {activityTabStateShape, type ActivityTabState} from '@agent-storm/common';
import {
    PaneMounting,
    updateTabState,
    type PaneDefinition,
    type PaneRenderParams,
} from '@agent-storm/core/frontend';
import {createSizedIcon, LucideAppWindowIcon} from 'vira';

function renderActivity(params: PaneRenderParams<typeof activityTabStateShape>) {
    return params.context.renderActivityTab({
        paths: params.tabState.activityPaths,
        navigate(paths) {
            params.writeLayout((current) => {
                return updateTabState(current, {
                    tabId: params.tabId,
                    state: {
                        activityPaths: [
                            ...paths,
                        ],
                    } satisfies Partial<ActivityTabState>,
                });
            });
        },
    });
}

/** A tab showing a whole activity, with its own selection apart from its vertical tab's. */
export const activityPane: PaneDefinition<typeof activityTabStateShape> = {
    id: 'activity',
    tabStateShape: activityTabStateShape,
    label({tabState, context}) {
        const activityId = tabState.activityPaths[0];
        return (
            context.activities.find((activity) => activity.id === activityId)?.label || 'Activity'
        );
    },
    newTabEntries() {
        return [];
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
