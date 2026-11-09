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
function createContext(enabledActivities: Readonly<Record<string, boolean>> | undefined) {
    return {
        activities,
        activityStates: {},
        uiLayout: {
            value: {
                layout: enabledActivities && {
                    ...uiLayoutShape.default,
                    enabledActivities,
                },
                selections: {},
            },
        },
    } satisfies Pick<AppContext, 'activities' | 'activityStates'> & {
        uiLayout: Pick<AppContext['uiLayout'], 'value'>;
    } as unknown as AppContext;
}

function findRedirect(
    paths: ReadonlyArray<string>,
    enabledActivities: Readonly<Record<string, boolean>> | undefined = {},
) {
    return resolveActivityRoute({
        paths,
        context: createContext(enabledActivities),
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

    it('throws for an id no activity has', () => {
        assert.throws(() => findRedirect(['missing']));
    });
});
