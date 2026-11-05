import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {extractBearerToken} from './auth.js';

describe(extractBearerToken.name, () => {
    it('reads the token from a bearer header in any casing', () => {
        assert.deepEquals(
            [
                'Bearer abc',
                '  bearer   abc  ',
                'BEARER abc',
            ].map(extractBearerToken),
            [
                'abc',
                'abc',
                'abc',
            ],
        );
    });

    it('rejects other schemes, empty tokens, and repeated headers', () => {
        assert.deepEquals(
            [
                'Basic abc',
                'Bearer ',
                'BearerToken',
                undefined,
                [
                    'Bearer abc',
                ],
            ].map(extractBearerToken),
            [
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
            ],
        );
    });
});
