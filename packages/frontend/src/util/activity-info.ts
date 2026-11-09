import {type AppContext} from './app-context.js';
import {ActivityId} from './router.js';

/** What the app knows about each activity without rendering it. */
export const activityInfo: Readonly<
    Record<
        ActivityId,
        Readonly<{
            label: string;
            /** Whether the activity is on until the user chooses otherwise. */
            isEnabledByDefault: boolean;
        }>
    >
> = {
    [ActivityId.Dashboard]: {
        label: 'Dashboard',
        isEnabledByDefault: true,
    },
    [ActivityId.Build]: {
        label: 'Build',
        isEnabledByDefault: true,
    },
    [ActivityId.Review]: {
        label: 'Review',
        isEnabledByDefault: true,
    },
    [ActivityId.Debug]: {
        label: 'Debug',
        isEnabledByDefault: false,
    },
};

/**
 * Whether an activity is on. A turned-off activity has no vertical tab, no new-tab entry, and its
 * URL redirects.
 */
export function isActivityEnabled(context: Pick<AppContext, 'uiLayout'>, activityId: ActivityId) {
    return (
        context.uiLayout.value.layout?.enabledActivities[activityId] ??
        activityInfo[activityId].isEnabledByDefault
    );
}
