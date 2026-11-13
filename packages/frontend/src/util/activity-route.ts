import {
    isActivityEnabled,
    type AnyActivityDefinition,
    type AppContext,
} from '@agent-storm/core/frontend';

/** Every main tab, in the stored order: listed tabs first, then the rest in their default order. */
export function orderMainTabs(
    storedOrder: ReadonlyArray<string>,
    activities: ReadonlyArray<AnyActivityDefinition>,
) {
    const listed = storedOrder
        .filter((id, index) => storedOrder.indexOf(id) === index)
        .map((id) => activities.find((activity) => activity.id === id))
        .filter((activity) => activity != undefined);
    return [
        ...listed,
        ...activities.filter((activity) => !listed.includes(activity)),
    ];
}

/** The first enabled main tab, in the order the user arranged the tabs. */
function findFirstEnabledActivity(context: AppContext) {
    return orderMainTabs(
        context.uiLayout.value.layout?.mainTabOrder || [],
        context.activities,
    ).find((entry) => isActivityEnabled(context, entry));
}

/**
 * Which activity `paths` select, and where to go instead (`redirect`): the first enabled main tab
 * when this one is turned off, the activity's own redirect when its segments can't be valid, or its
 * remembered selection when it has nothing selected. `activity` is undefined when no activity has
 * the first segment as its id, which redirects to the first enabled main tab once the plugin list
 * and the layout have loaded, since the missing activity may be a plugin's that isn't listed yet.
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
        const fallback = findFirstEnabledActivity(context) || context.activities[0];
        return {
            activity: undefined,
            subPaths: [],
            state: undefined,
            redirect:
                fallback && !context.plugins.value.isLoading && context.uiLayout.value.layout
                    ? {
                          paths: [
                              fallback.id,
                          ],
                          replace: true,
                      }
                    : undefined,
        };
    }
    const subPaths = paths.slice(1);
    const state = context.activityStates[activity.id];
    /** No activity counts as turned off until the layout holding the setting loads. */
    const enabledFallback =
        context.uiLayout.value.layout && !isActivityEnabled(context, activity)
            ? findFirstEnabledActivity(context)
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
