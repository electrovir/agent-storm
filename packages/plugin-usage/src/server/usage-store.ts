import {assertWrap} from '@augment-vir/assert';
import {awaitedForEach, omitObjectKeys} from '@augment-vir/common';
import {convertDuration, createFullDateInUserTimezone, toSimpleDatePartString} from 'date-vir';
import {
    type DailyUsage,
    type PlanLimitPoint,
    type PlanLimitWindow,
    type UsageGroup,
    UsageProvider,
    UsageSource,
    type UsageTotals,
} from '../usage-api.js';
import {type UsageRecordInput} from '../usage-exports.js';
import {type PrismaClient} from './generated/client.js';
import {estimateCost, findModelPrice, type ModelPrices} from './model-prices.js';

/** How long plan-limit readings are kept. */
const planLimitHistoryAge = {
    days: 90,
} as const;

type SummedRow = Readonly<{
    isCostEstimated: boolean;
    _sum: Readonly<{
        inputTokens: number | null;
        outputTokens: number | null;
        cacheReadTokens: number | null;
        cacheWriteTokens: number | null;
        costUsd: number | null;
    }>;
    _count: Readonly<{
        _all: number;
        costUsd: number;
    }>;
}>;

const summedFields = {
    _sum: {
        inputTokens: true,
        outputTokens: true,
        cacheReadTokens: true,
        cacheWriteTokens: true,
        costUsd: true,
    },
    _count: {
        _all: true,
        costUsd: true,
    },
} as const;

function addRowToTotals(totals: Readonly<UsageTotals> | undefined, row: SummedRow): UsageTotals {
    return {
        inputTokens: (totals?.inputTokens || 0) + (row._sum.inputTokens || 0),
        outputTokens: (totals?.outputTokens || 0) + (row._sum.outputTokens || 0),
        cacheReadTokens: (totals?.cacheReadTokens || 0) + (row._sum.cacheReadTokens || 0),
        cacheWriteTokens: (totals?.cacheWriteTokens || 0) + (row._sum.cacheWriteTokens || 0),
        costUsd: (totals?.costUsd || 0) + (row._sum.costUsd || 0),
        hasEstimatedCost:
            !!totals?.hasEstimatedCost || (row.isCostEstimated && row._count.costUsd > 0),
        hasUnpricedTokens: !!totals?.hasUnpricedTokens || row._count._all > row._count.costUsd,
    };
}

/**
 * Merges rows that differ only in whether their cost was estimated, which the queries group by to
 * tell the two apart.
 */
export function mergeSummedRows<const Row extends SummedRow, const Key>(
    rows: ReadonlyArray<Row>,
    toKey: (row: Row) => Key,
) {
    return [
        ...rows
            .reduce((merged, row) => {
                const key = JSON.stringify(toKey(row));
                const existing = merged.get(key);
                return merged.set(key, {
                    key: toKey(row),
                    firstRow: existing?.firstRow || row,
                    totals: addRowToTotals(existing?.totals, row),
                });
            }, new Map<string, {key: Key; firstRow: Row; totals: UsageTotals}>())
            .values(),
    ];
}

export function toLocalDay(epochMilliseconds: number) {
    return toSimpleDatePartString(createFullDateInUserTimezone(epochMilliseconds));
}

/** Reads and writes the usage database. */
export function createUsageStore(prismaClient: PrismaClient) {
    return {
        async recordUsages(
            records: ReadonlyArray<UsageRecordInput>,
            prices: Readonly<ModelPrices>,
        ) {
            await prismaClient.$transaction(
                records.map((record) => {
                    const price = findModelPrice(prices, record.model);
                    const occurredAt = record.occurredAt ?? Date.now();
                    const estimatedCost =
                        record.costUsd == undefined && price
                            ? estimateCost({
                                  ...record,
                                  price,
                              })
                            : undefined;
                    const data = {
                        occurredAt,
                        day: toLocalDay(occurredAt),
                        source: record.source,
                        provider: record.provider,
                        model: record.model,
                        inputTokens: record.inputTokens,
                        outputTokens: record.outputTokens,
                        cacheReadTokens: record.cacheReadTokens,
                        cacheWriteTokens: record.cacheWriteTokens,
                        reasoningTokens: record.reasoningTokens ?? 0,
                        costUsd: record.costUsd ?? estimatedCost ?? null,
                        isCostEstimated: estimatedCost != undefined,
                        repoPath: record.repoPath,
                        folder: record.folder,
                        threadId: record.threadId || null,
                        prUrl: record.prUrl || null,
                        label: record.label || null,
                    };
                    return prismaClient.usageRecord.upsert({
                        where: {
                            dedupeKey: record.dedupeKey,
                        },
                        create: {
                            ...data,
                            dedupeKey: record.dedupeKey,
                        },
                        update: data,
                        select: {
                            id: true,
                        },
                    });
                }),
            );
        },
        async readThreadCost({threadId, since}: Readonly<{threadId: string; since: number}>) {
            const totals = await prismaClient.usageRecord.aggregate({
                where: {
                    threadId,
                    occurredAt: {
                        gte: since,
                    },
                },
                _sum: {
                    costUsd: true,
                },
                _count: {
                    _all: true,
                    costUsd: true,
                },
            });
            return {
                costUsd: totals._sum.costUsd ?? 0,
                hasUnpricedTokens: totals._count._all > totals._count.costUsd,
            };
        },
        /** Prices the records saved before a price for their model was known. */
        async estimateMissingCosts(prices: Readonly<ModelPrices>) {
            const models = await prismaClient.usageRecord.groupBy({
                by: [
                    'model',
                ],
                where: {
                    costUsd: null,
                },
            });
            await awaitedForEach(models, async ({model}) => {
                const price = findModelPrice(prices, model);
                if (!price) {
                    return;
                }
                await prismaClient.$executeRaw`
                    UPDATE "UsageRecord"
                    SET
                        "costUsd" = "inputTokens" * ${price.input}
                            + "outputTokens" * ${price.output}
                            + "cacheReadTokens" * ${price.cacheRead}
                            + "cacheWriteTokens" * ${price.cacheWrite},
                        "isCostEstimated" = true
                    WHERE "costUsd" IS NULL AND "model" = ${model}
                `;
            });
        },
        async recordPlanLimits({
            provider,
            windows,
            recordedAt,
        }: Readonly<{
            provider: UsageProvider;
            windows: ReadonlyArray<Readonly<PlanLimitWindow>>;
            /** Epoch milliseconds. */
            recordedAt: number;
        }>) {
            await prismaClient.planLimitSnapshot.createMany({
                data: windows.map((window) => {
                    return {
                        recordedAt,
                        provider,
                        windowId: window.windowId,
                        label: window.label,
                        usedPercent: window.usedPercent,
                        resetsAt: window.resetsAt ?? null,
                    };
                }),
            });
        },
        async deleteOldPlanLimits() {
            await prismaClient.planLimitSnapshot.deleteMany({
                where: {
                    recordedAt: {
                        lt:
                            Date.now() -
                            convertDuration(planLimitHistoryAge, {
                                milliseconds: true,
                            }).milliseconds,
                    },
                },
            });
        },
        async readPlanLimitHistory(since: number) {
            const rows = await prismaClient.planLimitSnapshot.findMany({
                where: {
                    recordedAt: {
                        gte: since,
                    },
                },
                orderBy: {
                    recordedAt: 'asc',
                },
                select: {
                    provider: true,
                    windowId: true,
                    label: true,
                    usedPercent: true,
                    recordedAt: true,
                },
            });
            return rows.map((row): PlanLimitPoint => {
                return {
                    ...omitObjectKeys(row, [
                        'provider',
                    ]),
                    provider: assertWrap.isEnumValue(row.provider, UsageProvider),
                };
            });
        },
        async readUsage(sinceDay: string) {
            const where = {
                day: {
                    gte: sinceDay,
                },
            };
            const [
                dailyRows,
                groupRows,
            ] = await Promise.all([
                prismaClient.usageRecord.groupBy({
                    by: [
                        'day',
                        'provider',
                        'isCostEstimated',
                    ],
                    where,
                    ...summedFields,
                }),
                prismaClient.usageRecord.groupBy({
                    by: [
                        'source',
                        'provider',
                        'repoPath',
                        'folder',
                        'threadId',
                        'prUrl',
                        'isCostEstimated',
                    ],
                    where,
                    _max: {
                        label: true,
                    },
                    ...summedFields,
                }),
            ]);
            return {
                daily: mergeSummedRows(dailyRows, (row) => {
                    return {
                        day: row.day,
                        provider: row.provider,
                    };
                })
                    .map(({key, totals}): DailyUsage => {
                        return {
                            day: key.day,
                            provider: assertWrap.isEnumValue(key.provider, UsageProvider),
                            totals,
                        };
                    })
                    .sort((first, second) => first.day.localeCompare(second.day)),
                groups: mergeSummedRows(groupRows, (row) => {
                    return {
                        source: row.source,
                        provider: row.provider,
                        repoPath: row.repoPath,
                        folder: row.folder,
                        threadId: row.threadId,
                        prUrl: row.prUrl,
                    };
                })
                    .map(({key, firstRow, totals}): UsageGroup => {
                        return {
                            ...omitObjectKeys(key, [
                                'source',
                                'provider',
                            ]),
                            source: assertWrap.isEnumValue(key.source, UsageSource),
                            provider: assertWrap.isEnumValue(key.provider, UsageProvider),
                            label: firstRow._max.label,
                            totals,
                        };
                    })
                    .sort((first, second) => second.totals.costUsd - first.totals.costUsd),
            };
        },
    };
}
