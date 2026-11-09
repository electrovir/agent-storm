import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {defineShape} from 'object-shape-tester';
import {resolveTabState} from './pane-layout.js';

describe(resolveTabState.name, () => {
    const tabStateShape = defineShape({
        name: 'default',
        paths: [
            '',
        ],
    });

    it('uses the tab’s own valid values over the defaults', () => {
        assert.deepEquals(
            [
                resolveTabState({
                    tabStateShape,
                    tabState: undefined,
                }),
                resolveTabState({
                    tabStateShape,
                    tabState: {
                        name: 'mine',
                    },
                }),
            ],
            [
                {
                    name: 'default',
                    paths: [],
                },
                {
                    name: 'mine',
                    paths: [],
                },
            ],
        );
    });
    it('replaces an invalid value with its default and drops unknown keys', () => {
        assert.deepEquals(
            resolveTabState({
                tabStateShape,
                tabState: {
                    name: 5,
                    paths: [
                        'a',
                    ],
                    stale: true,
                },
            }),
            {
                name: 'default',
                paths: [
                    'a',
                ],
            },
        );
    });
});
