import {assertWrap} from '@augment-vir/assert';
import {
    type AnyDuration,
    convertDuration,
    getNowInUserTimezone,
    maybeCreateFullDate,
    toRelativeString,
    utcTimezone,
} from 'date-vir';

/** "3 hours ago" for a GitHub UTC ISO timestamp; the raw string if it doesn't parse. */
export function relativeTime(isoTimestamp: string): string {
    const created = maybeCreateFullDate(isoTimestamp, utcTimezone);
    if (!created) {
        return isoTimestamp;
    }
    /**
     * `start` is now and `end` is the timestamp: the diff runs end minus start, so a past comment
     * has to be the end of the range to come out negative and read as "3 hours ago".
     */
    return toRelativeString(
        {
            start: getNowInUserTimezone(),
            end: created,
        },
        {
            days: true,
            hours: true,
            minutes: true,
        },
        {
            useOnlyLargestUnit: true,
            decimalCount: 0,
        },
    );
}

/** Largest first; the first one that fits the elapsed time labels it. */
const ageUnits: ReadonlyArray<{
    label: string;
    size: AnyDuration;
}> = [
    {
        label: 'y',
        size: {
            years: 1,
        },
    },
    {
        label: 'w',
        size: {
            weeks: 1,
        },
    },
    {
        label: 'd',
        size: {
            days: 1,
        },
    },
    {
        label: 'h',
        size: {
            hours: 1,
        },
    },
    {
        label: 'm',
        size: {
            minutes: 1,
        },
    },
];

/**
 * Time from `timestamp` to `now` (both ms) in only its largest unit, abbreviated, like `5m`. Under
 * a minute reads `0m`.
 */
export function compactAge({timestamp, now}: Readonly<{timestamp: number; now: number}>) {
    const elapsed = Math.max(0, now - timestamp);
    const unit = assertWrap.isDefined(
        ageUnits.find((ageUnit, index) => {
            return (
                index === ageUnits.length - 1 ||
                elapsed >=
                    convertDuration(ageUnit.size, {
                        milliseconds: true,
                    }).milliseconds
            );
        }),
    );
    return `${Math.floor(
        elapsed /
            convertDuration(unit.size, {
                milliseconds: true,
            }).milliseconds,
    )}${unit.label}`;
}
