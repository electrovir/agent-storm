// cspell:word ultrafast

import {assert, assertWrap} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {bundleSqliteWorker} from 'agent-storm-util/src/sqlite-worker.mock.js';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {UsageProvider, UsageSource, UsageSpeed} from '../usage-api.js';
import {type UsageRecordInput} from '../usage-exports.js';
import {type PrismaClient} from './generated/client.js';
import {estimateCost, type ModelPrices, speedPriceChangesAt} from './model-prices.js';
import {openUsageDatabase} from './usage-database.js';
import {createUsageStore} from './usage-store.js';

const prices: ModelPrices = {
    'gpt-6.2-test': {
        input: 1,
        output: 10,
        cacheRead: 100,
        cacheWrite: 1000,
    },
};

const baseRecord = {
    source: UsageSource.Build,
    provider: UsageProvider.Codex,
    model: 'gpt-6.2-test',
    speed: UsageSpeed.Ultrafast,
    inputTokens: 1,
    outputTokens: 2,
    cacheReadTokens: 3,
    cacheWriteTokens: 4,
    repoPath: '/repo',
    folder: '/repo',
    threadId: 'thread-1',
    occurredAt: speedPriceChangesAt,
} as const satisfies Omit<UsageRecordInput, 'dedupeKey'>;

async function withUsageStore(
    callback: (
        params: Readonly<{
            store: ReturnType<typeof createUsageStore>;
            prismaClient: PrismaClient;
        }>,
    ) => Promise<void>,
) {
    const dir = await mkdtemp(join(tmpdir(), 'usage-store-'));
    const prismaClient = await openUsageDatabase(
        dir,
        resolve(import.meta.dirname, '..', '..', 'prisma', 'migrations'),
        await bundleSqliteWorker(dir),
    );
    try {
        await callback({
            store: createUsageStore(prismaClient),
            prismaClient,
        });
    } finally {
        await prismaClient.$disconnect();
        await rm(dir, {
            recursive: true,
            force: true,
        });
    }
}

describe('readThreadsCost', () => {
    it('adds up only the given threads since the window starts', async () => {
        await withUsageStore(async ({store}) => {
            await store.recordUsages(
                [
                    {
                        ...baseRecord,
                        dedupeKey: 'in-window',
                        costUsd: 1,
                    },
                    {
                        ...baseRecord,
                        dedupeKey: 'before-window',
                        occurredAt: speedPriceChangesAt - 1,
                        costUsd: 10,
                    },
                    {
                        ...baseRecord,
                        dedupeKey: 'other-given-thread',
                        threadId: 'thread-2',
                        costUsd: 100,
                    },
                    {
                        ...baseRecord,
                        dedupeKey: 'thread-not-given',
                        threadId: 'thread-3',
                        costUsd: 1000,
                    },
                ],
                prices,
            );
            assert.deepEquals(
                await store.readThreadsCost({
                    threadIds: [
                        'thread-1',
                        'thread-2',
                    ],
                    since: speedPriceChangesAt,
                }),
                {
                    costUsd: 101,
                    hasUnpricedTokens: false,
                },
            );
        });
    });
    it('flags unpriced tokens only inside the window', async () => {
        await withUsageStore(async ({store}) => {
            await store.recordUsages(
                [
                    {
                        ...baseRecord,
                        dedupeKey: 'priced',
                        costUsd: 1,
                    },
                    {
                        ...baseRecord,
                        dedupeKey: 'unpriced',
                        model: 'unknown-model',
                        occurredAt: speedPriceChangesAt - 1,
                    },
                ],
                prices,
            );
            assert.deepEquals(
                await Promise.all(
                    [
                        speedPriceChangesAt,
                        speedPriceChangesAt - 1,
                    ].map(async (since) => {
                        return await store.readThreadsCost({
                            threadIds: [
                                'thread-1',
                            ],
                            since,
                        });
                    }),
                ),
                [
                    {
                        costUsd: 1,
                        hasUnpricedTokens: false,
                    },
                    {
                        costUsd: 1,
                        hasUnpricedTokens: true,
                    },
                ],
            );
        });
    });
});

describe('estimateMissingCosts', () => {
    it('prices records the same as estimateCost on both sides of a speed price change', async () => {
        await withUsageStore(async ({store, prismaClient}) => {
            const occurredTimes = [
                speedPriceChangesAt - 1,
                speedPriceChangesAt,
            ];
            await store.recordUsages(
                occurredTimes.map((occurredAt) => {
                    return {
                        ...baseRecord,
                        dedupeKey: `${occurredAt}`,
                        occurredAt,
                    };
                }),
                {},
            );
            await store.estimateMissingCosts(prices);
            assert.deepEquals(
                await prismaClient.usageRecord.findMany({
                    select: {
                        costUsd: true,
                        isCostEstimated: true,
                    },
                    orderBy: {
                        occurredAt: 'asc',
                    },
                }),
                occurredTimes.map((occurredAt) => {
                    return {
                        costUsd: estimateCost({
                            ...baseRecord,
                            occurredAt,
                            price: assertWrap.isDefined(prices['gpt-6.2-test']),
                        }),
                        isCostEstimated: true,
                    };
                }),
            );
        });
    });
});
