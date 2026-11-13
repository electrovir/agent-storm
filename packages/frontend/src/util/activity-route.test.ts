import {uiLayoutShape} from '@agent-storm/common';
import {
    defineActivity,
    type AnyActivityDefinition,
    type AppContext,
} from '@agent-storm/core/frontend';
import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {html} from 'element-vir';
import {resolveActivityRoute} from './activity-route.js';

function createActivity(
    overrides: Readonly<Pick<AnyActivityDefinition, 'id'> & Partial<AnyActivityDefinition>>,
) {
    return defineActivity({
        label: overrides.id,
        isEnabledByDefault: true,
        mobileMenuTitle: undefined,
        sidebar: undefined,
        isKeptMounted: false,
        render() {
            return html``;
        },
        ...overrides,
    });
}

const activities = [
    createActivity({
        id: 'first',
    }),
    createActivity({
        id: 'picker',
        findRedirect({subPaths}) {
            return subPaths.length > 1 ? [] : undefined;
        },
        findRestoredSubPaths() {
            return ['remembered'];
        },
    }),
];

/** Only what `resolveActivityRoute` reads; the activities above ignore the rest. */
function createContext({
    enabledActivities,
    arePluginsLoading,
    mainTabOrder = [],
}: Readonly<{
    enabledActivities: Readonly<Record<string, boolean>> | undefined;
    arePluginsLoading: boolean;
    mainTabOrder?: ReadonlyArray<string> | undefined;
}>) {
    return {
        activities,
        activityStates: {},
        plugins: {
            value: {
                isLoading: arePluginsLoading,
            },
        },
        uiLayout: {
            value: {
                layout: enabledActivities && {
                    ...uiLayoutShape.default,
                    enabledActivities,
                    mainTabOrder: [
                        ...mainTabOrder,
                    ],
                },
                selections: {},
            },
        },
    } satisfies Pick<AppContext, 'activities' | 'activityStates'> & {
        uiLayout: Pick<AppContext['uiLayout'], 'value'>;
        plugins: {
            value: Pick<AppContext['plugins']['value'], 'isLoading'>;
        };
    } as unknown as AppContext;
}

function findRedirect(
    paths: ReadonlyArray<string>,
    enabledActivities: Readonly<Record<string, boolean>> | undefined = {},
    arePluginsLoading = false,
) {
    return resolveActivityRoute({
        paths,
        context: createContext({
            enabledActivities,
            arePluginsLoading,
        }),
    }).redirect;
}

describe(resolveActivityRoute.name, () => {
    it('pushes the redirect for segments that cannot be valid', () => {
        assert.deepEquals(
            findRedirect([
                'picker',
                'a',
                'b',
            ]),
            {
                paths: ['picker'],
                replace: false,
            },
        );
    });

    it('replaces a bare route with the remembered selection', () => {
        assert.deepEquals(
            [
                findRedirect(['picker']),
                findRedirect([
                    'picker',
                    'a',
                ]),
            ],
            [
                {
                    paths: [
                        'picker',
                        'remembered',
                    ],
                    replace: true,
                },
                undefined,
            ],
        );
    });

    it('leaves an activity that is turned off, once the layout has loaded', () => {
        assert.deepEquals(
            [
                findRedirect(
                    [
                        'first',
                    ],
                    {
                        first: false,
                    },
                ),
                findRedirect(
                    [
                        'first',
                    ],
                    undefined,
                ),
            ],
            [
                {
                    paths: ['picker'],
                    replace: true,
                },
                undefined,
            ],
        );
    });

    it('leaves an id no activity has only once every plugin has loaded', () => {
        assert.deepEquals(
            [
                findRedirect(['missing']),
                findRedirect(
                    [
                        'missing',
                    ],
                    {},
                    true,
                ),
            ],
            [
                {
                    paths: ['first'],
                    replace: true,
                },
                undefined,
            ],
        );
    });

    it('redirects to the first enabled main tab in the order the user arranged them', () => {
        assert.deepEquals(
            [
                resolveActivityRoute({
                    paths: ['missing'],
                    context: createContext({
                        enabledActivities: {},
                        arePluginsLoading: false,
                        mainTabOrder: ['picker'],
                    }),
                }).redirect,
                resolveActivityRoute({
                    paths: ['missing'],
                    context: createContext({
                        enabledActivities: undefined,
                        arePluginsLoading: false,
                        mainTabOrder: ['picker'],
                    }),
                }).redirect,
            ],
            [
                {
                    paths: ['picker'],
                    replace: true,
                },
                undefined,
            ],
        );
    });
});
