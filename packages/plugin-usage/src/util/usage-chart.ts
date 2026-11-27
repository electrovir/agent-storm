import {createArray, getEnumValues} from '@augment-vir/common';
import {
    calculateRelativeDate,
    getNowInUserTimezone,
    toSimpleDatePartString,
    type FullDate,
} from 'date-vir';
import {UsageProvider, type DailyUsage, type UsageTotals} from '../usage-api.js';

/** What a daily chart measures. */
export enum UsageMeasure {
    Cost = 'cost',
    Tokens = 'tokens',
}

export const usageMeasureReaders: Readonly<
    Record<UsageMeasure, (totals: Readonly<UsageTotals>) => number>
> = {
    [UsageMeasure.Cost](totals) {
        return totals.costUsd;
    },
    [UsageMeasure.Tokens](totals) {
        return (
            totals.inputTokens +
            totals.outputTokens +
            totals.cacheReadTokens +
            totals.cacheWriteTokens
        );
    },
};

/**
 * Categorical series colors, in a fixed order: Claude always takes the first and Codex the second,
 * so a provider keeps its color whichever providers a chart shows.
 */
export const providerColors: Readonly<
    Record<
        UsageProvider,
        Readonly<{
            light: string;
            dark: string;
        }>
    >
> = {
    [UsageProvider.Claude]: {
        light: '#2a78d6',
        dark: '#3987e5',
    },
    [UsageProvider.Codex]: {
        light: '#eb6834',
        dark: '#d95926',
    },
};

/** The `dayCount` local days ending with `today`, oldest first, as YYYY-MM-DD. */
export function listRecentDays(
    dayCount: number,
    today: Readonly<FullDate> = getNowInUserTimezone(),
) {
    const firstDay = calculateRelativeDate(today, {
        days: 1 - dayCount,
    });
    return createArray(dayCount, (index) => {
        return toSimpleDatePartString(
            calculateRelativeDate(firstDay, {
                days: index,
            }),
        );
    });
}

/** Each provider's value on each of `days`, zero on days it wasn't used. */
export function toProviderDailyValues({
    daily,
    days,
    measure,
}: Readonly<{
    daily: ReadonlyArray<Readonly<DailyUsage>>;
    days: ReadonlyArray<string>;
    measure: UsageMeasure;
}>) {
    return getEnumValues(UsageProvider).map((provider) => {
        return {
            provider,
            values: days.map((day) => {
                const usage = daily.find(
                    (entry) => entry.day === day && entry.provider === provider,
                );
                return usage ? usageMeasureReaders[measure](usage.totals) : 0;
            }),
        };
    });
}

export function formatUsd(value: number) {
    return new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    }).format(value);
}

/** A token count shortened the way the user's locale shortens big numbers, such as `1.2M`. */
export function formatTokenCount(value: number) {
    return new Intl.NumberFormat(undefined, {
        notation: 'compact',
        maximumFractionDigits: 1,
    }).format(value);
}

/** A YYYY-MM-DD day as the user's locale writes a short date, such as `Nov 19`. */
export function formatDay(day: string) {
    return new Intl.DateTimeFormat(undefined, {
        month: 'short',
        day: 'numeric',
        /** `Date.parse` reads a bare date as UTC midnight, so formatting in UTC keeps its day. */
        timeZone: 'UTC',
    }).format(Date.parse(day));
}

/** The last segment of `path`. */
export function findPathName(path: string) {
    return path.split('/').findLast(Boolean) || path;
}

/** A PR's `owner/repo#number` from its GitHub URL, or the URL itself when it isn't one. */
export function shortenPrUrl(prUrl: string) {
    const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(prUrl);
    return match ? `${match[1]}#${match[2]}` : prUrl;
}
