import {uiLayoutShape} from '@agent-storm/common';
import {defineActivity, type AppContext} from '@agent-storm/core/frontend';
import {assert} from '@augment-vir/assert';
import {selectFrom} from '@augment-vir/common';
import {describe, it} from '@augment-vir/test';
import {html} from 'element-vir';
import {listActivityToggles} from './activity-toggles.js';

const activities = [
    'first',
    'second',
    'pending',
].map((id) => {
    return defineActivity({
        id,
        label: id,
        isEnabledByDefault: true,
        mobileMenuTitle: undefined,
        sidebar: undefined,
        isKeptMounted: false,
        render() {
            return html``;
        },
    });
});

function listToggles(enabledActivities: Readonly<Record<string, boolean>>) {
    return listActivityToggles({
        /** Only what `listActivityToggles` reads. */
        context: {
            plugins: {
                value: {
                    pendingActivityIds: [
                        'pending',
                    ],
                },
            },
            uiLayout: {
                value: {
                    layout: {
                        ...uiLayoutShape.default,
                        enabledActivities,
                    },
                    selections: {},
                },
            },
        } satisfies {
            plugins: {
                value: Pick<AppContext['plugins']['value'], 'pendingActivityIds'>;
            };
            uiLayout: Pick<AppContext['uiLayout'], 'value'>;
        } as unknown as AppContext,
        activities,
    }).map((toggle) => {
        return selectFrom(toggle, {
            activity: {
                id: true,
            },
            isEnabled: true,
            isLastEnabled: true,
        });
    });
}

describe(listActivityToggles.name, () => {
    it('leaves out pending activities and marks the only enabled one', () => {
        assert.deepEquals(
            [
                listToggles({}),
                listToggles({
                    second: false,
                }),
            ],
            [
                [
                    {
                        activity: {
                            id: 'first',
                        },
                        isEnabled: true,
                        isLastEnabled: false,
                    },
                    {
                        activity: {
                            id: 'second',
                        },
                        isEnabled: true,
                        isLastEnabled: false,
                    },
                ],
                [
                    {
                        activity: {
                            id: 'first',
                        },
                        isEnabled: true,
                        isLastEnabled: true,
                    },
                    {
                        activity: {
                            id: 'second',
                        },
                        isEnabled: false,
                        isLastEnabled: false,
                    },
                ],
            ],
        );
    });
});
