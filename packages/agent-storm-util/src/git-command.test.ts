import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {packGraphqlParts, parseGhDebugOutput} from './git-command.js';

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

describe(parseGhDebugOutput.name, () => {
    it('reads rate limits and keeps only the stderr gh prints without debug output', () => {
        assert.deepEquals(
            parseGhDebugOutput(
                [
                    '[git remote -v]',
                    '* Request at 2026-11-16 11:42:38 -0700 MST',
                    '> POST /graphql HTTP/1.1',
                    '',
                    '{"query": "query { viewer { login } }"}',
                    '< HTTP/2.0 200 OK',
                    '< X-Ratelimit-Remaining: 4675',
                    '< X-Ratelimit-Reset: 1794858013',
                    '< X-Ratelimit-Resource: graphql',
                    '< X-Ratelimit-Used: 325',
                    '',
                    '{"data": {"message": "rate limit"}}',
                    '* Request took 363ms',
                    'GraphQL: Could not resolve to a PullRequest',
                ].join('\n'),
            ),
            {
                stderr: 'GraphQL: Could not resolve to a PullRequest',
                rateLimits: [
                    {
                        resource: 'graphql',
                        used: 325,
                        remaining: 4675,
                        resetAt: 1_794_858_013,
                    },
                ],
            },
        );
    });
    it('keeps non-debug lines of a request that never finished', () => {
        assert.deepEquals(
            parseGhDebugOutput(
                [
                    '* Request at 2026-11-16 11:42:38 -0700 MST',
                    '> POST /graphql HTTP/1.1',
                    'error connecting to api.github.com',
                ].join('\n'),
            ),
            {
                stderr: 'error connecting to api.github.com',
                rateLimits: [],
            },
        );
    });
});
