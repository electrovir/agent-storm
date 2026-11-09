import {
    isActivityEnabled,
    type AnyActivityDefinition,
    type AppContext,
} from '@agent-storm/core/frontend';

/**
 * Which activity `paths` select, and where to go instead (`redirect`): the first enabled activity
 * when this one is turned off, the activity's own redirect when its segments can't be valid, or its
 * remembered selection when it has nothing selected.
 *
 * `paths` must already start with an activity id (see `sanitizeActivityPaths`).
 */
export function resolveActivityRoute({
    paths,
    context,
}: Readonly<{
    paths: ReadonlyArray<string>;
    context: AppContext;
}>) {
    const activity: AnyActivityDefinition | undefined = context.activities.find((entry) => {
        return entry.id === paths[0];
    });
    if (!activity) {
        throw new Error(`No activity has id '${paths[0]}'.`);
    }
    const subPaths = paths.slice(1);
    const state = context.activityStates[activity.id];
    /** No activity counts as turned off until the layout holding the setting loads. */
    const enabledFallback =
        context.uiLayout.value.layout && !isActivityEnabled(context, activity)
            ? context.activities.find((entry) => isActivityEnabled(context, entry))
            : undefined;
    const invalidRedirect =
        !enabledFallback &&
        activity.findRedirect?.({
            context,
            state,
            subPaths,
        });
    const restoredSubPaths =
        enabledFallback || invalidRedirect || subPaths.length
            ? undefined
            : activity.findRestoredSubPaths?.({
                  context,
                  state,
              });

    const redirect = enabledFallback
        ? {
              paths: [
                  enabledFallback.id,
              ],
              replace: true,
          }
        : invalidRedirect
          ? {
                paths: [
                    activity.id,
                    ...invalidRedirect,
                ],
                replace: false,
            }
          : restoredSubPaths && {
                paths: [
                    activity.id,
                    ...restoredSubPaths,
                ],
                replace: true,
            };

    return {
        activity,
        subPaths,
        state,
        redirect,
    };
}
