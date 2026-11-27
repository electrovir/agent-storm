import {getNowInUserTimezone, maybeCreateFullDate, toRelativeString, utcTimezone} from 'date-vir';

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
