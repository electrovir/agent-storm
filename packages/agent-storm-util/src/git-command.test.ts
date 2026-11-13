import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {packGraphqlParts} from './git-command.js';

describe(packGraphqlParts.name, () => {
    it('fills each group up to one point', () => {
        assert.deepEquals(
            packGraphqlParts({
                parts: [
                    100,
                    40,
                    60,
                    9,
                ],
                countRequests(part) {
                    return part;
                },
            }),
            [
                [
                    100,
                    40,
                    9,
                ],
                [
                    60,
                ],
            ],
        );
    });
    it('gives a part over one point its own group', () => {
        assert.deepEquals(
            packGraphqlParts({
                parts: [
                    1,
                    200,
                ],
                countRequests(part) {
                    return part;
                },
            }),
            [
                [
                    200,
                ],
                [
                    1,
                ],
            ],
        );
    });
});
