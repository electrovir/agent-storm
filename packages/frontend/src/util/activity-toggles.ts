import {
    isActivityEnabled,
    type AnyActivityDefinition,
    type AppContext,
} from '@agent-storm/core/frontend';

/**
 * Each of `activities` that the user can show or hide, in the given order. A pending plugin's
 * activities are stand-ins, so they are left out. `isLastEnabled` marks the only one still shown,
 * which can't be hidden because the app would have nothing to show.
 */
export function listActivityToggles({
    context,
    activities,
}: Readonly<{
    context: Pick<AppContext, 'uiLayout' | 'plugins'>;
    activities: ReadonlyArray<AnyActivityDefinition>;
}>) {
    const toggles = activities
        .filter((activity) => !context.plugins.value.pendingActivityIds.includes(activity.id))
        .map((activity) => {
            return {
                activity,
                isEnabled: isActivityEnabled(context, activity),
            };
        });
    const enabledCount = toggles.filter((toggle) => toggle.isEnabled).length;
    return toggles.map((toggle) => {
        return {
            ...toggle,
            isLastEnabled: toggle.isEnabled && enabledCount === 1,
        };
    });
}

/** Shows or hides one activity's main tab, keeping every other activity's setting. */
export function setActivityEnabled({
    context,
    activity,
    isEnabled,
}: Readonly<{
    context: Pick<AppContext, 'uiLayout'>;
    activity: Readonly<Pick<AnyActivityDefinition, 'id'>>;
    isEnabled: boolean;
}>) {
    context.uiLayout.setActivityBar({
        enabledActivities: {
            ...context.uiLayout.value.layout?.enabledActivities,
            [activity.id]: isEnabled,
        },
    });
}
