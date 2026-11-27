import {definePluginApi} from '@agent-storm/common';
import {defineShape, enumShape, nullableShape} from 'object-shape-tester';

export const usagePluginId = 'usage';

/** The plugin whose AI run spent the tokens. */
export enum UsageSource {
    Build = 'build',
    Review = 'review',
}

export const usageSourceLabels: Readonly<Record<UsageSource, string>> = {
    [UsageSource.Build]: 'Build',
    [UsageSource.Review]: 'Review',
};

export enum UsageProvider {
    Claude = 'claude',
    Codex = 'codex',
}

export const usageProviderLabels: Readonly<Record<UsageProvider, string>> = {
    [UsageProvider.Claude]: 'Claude',
    [UsageProvider.Codex]: 'Codex',
};

export const planLimitWindowShape = defineShape({
    /** The provider's own name for the window, such as `five_hour`, stable across readings. */
    windowId: '',
    label: '',
    /** 0 to 100. */
    usedPercent: 0,
    /** Epoch milliseconds. */
    resetsAt: nullableShape(0),
});

export type PlanLimitWindow = typeof planLimitWindowShape.runtimeType;

export const planLimitsShape = defineShape({
    provider: enumShape(UsageProvider),
    /** The subscription, such as `max` or `plus`, when the provider names it. */
    planName: nullableShape(''),
    windows: [
        planLimitWindowShape,
    ],
    /** Why the latest reading failed. The windows are then the last successful reading's. */
    problem: nullableShape(''),
    /** Epoch milliseconds of the latest reading attempt. Zero before the first. */
    checkedAt: 0,
});

export type PlanLimits = typeof planLimitsShape.runtimeType;

const planLimitsListShape = defineShape({
    planLimits: [
        planLimitsShape,
    ],
});

export const usageTotalsShape = defineShape({
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
    /** Part of `costUsd` comes from public list prices rather than from the provider. */
    hasEstimatedCost: false,
    /** Some tokens used a model without a known price, so `costUsd` leaves them out. */
    hasUnpricedTokens: false,
});

export type UsageTotals = typeof usageTotalsShape.runtimeType;

export const dailyUsageShape = defineShape({
    /** The server's local day, as YYYY-MM-DD. */
    day: '',
    provider: enumShape(UsageProvider),
    totals: usageTotalsShape,
});

export type DailyUsage = typeof dailyUsageShape.runtimeType;

/** Usage for one place a plugin ran AI: a folder, a thread, or a PR. */
export const usageGroupShape = defineShape({
    source: enumShape(UsageSource),
    provider: enumShape(UsageProvider),
    repoPath: '',
    folder: '',
    threadId: nullableShape(''),
    prUrl: nullableShape(''),
    label: nullableShape(''),
    totals: usageTotalsShape,
});

export type UsageGroup = typeof usageGroupShape.runtimeType;

export const planLimitPointShape = defineShape({
    provider: enumShape(UsageProvider),
    windowId: '',
    label: '',
    usedPercent: 0,
    /** Epoch milliseconds. */
    recordedAt: 0,
});

export type PlanLimitPoint = typeof planLimitPointShape.runtimeType;

export const usageApi = definePluginApi({
    pluginId: usagePluginId,
    calls: {
        /** Each provider's latest plan limits, without reading them again. */
        readPlanLimits: {
            requestShape: defineShape({}),
            responseShape: planLimitsListShape,
        },
        /** Reads each provider's plan limits now. */
        refreshPlanLimits: {
            requestShape: defineShape({}),
            responseShape: planLimitsListShape,
        },
        readPlanLimitHistory: {
            requestShape: defineShape({
                /** Epoch milliseconds. */
                since: 0,
            }),
            responseShape: defineShape({
                points: [
                    planLimitPointShape,
                ],
            }),
        },
        readUsage: {
            requestShape: defineShape({
                /** The first local day to include, as YYYY-MM-DD. */
                sinceDay: '',
            }),
            responseShape: defineShape({
                daily: [
                    dailyUsageShape,
                ],
                /** Ordered by cost, highest first. */
                groups: [
                    usageGroupShape,
                ],
            }),
        },
    },
    events: {
        planLimitsChanged: planLimitsListShape,
        /** New usage was recorded. Sent at most every few seconds. */
        usageRecorded: defineShape({}),
    },
});
