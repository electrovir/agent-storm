import {type ClientFreezeRequest, type PerfTiming} from '@agent-storm/common';

/** What the page sends this worker every second while its main thread is running. */
export type FreezeWatchdogPing = Readonly<{
    isVisible: boolean;
    backendUrl: string;
    secret: string | undefined;
    activity: Readonly<Omit<ClientFreezeRequest, 'frozenSeconds' | 'isOngoing'>>;
}>;

export enum PerfCategory {
    Render = 'render',
    Request = 'request',
    Stall = 'stall',
}

/**
 * Mutated in place: renders are recorded on every element update, so a render loop would otherwise
 * copy these maps thousands of times a second, which is the very slowdown being measured.
 */
const currentWindow = {
    timings: new Map<PerfCategory, Map<string, PerfTiming>>(),
};

/** Adds one timed run of `name` to the current window. */
export function recordPerf({
    category,
    name,
    milliseconds,
}: Readonly<{
    category: PerfCategory;
    name: string;
    milliseconds: number;
}>) {
    const byName = currentWindow.timings.get(category) || new Map<string, PerfTiming>();
    currentWindow.timings.set(category, byName);
    const existing = byName.get(name);
    byName.set(name, {
        name,
        count: (existing?.count || 0) + 1,
        totalMilliseconds: (existing?.totalMilliseconds || 0) + milliseconds,
        maxMilliseconds: Math.max(existing?.maxMilliseconds || 0, milliseconds),
    });
}

function createCategoryReader(timings: ReadonlyMap<PerfCategory, ReadonlyMap<string, PerfTiming>>) {
    return function readCategory(category: PerfCategory) {
        return [
            ...(timings.get(category)?.values() || []),
        ];
    };
}

/** Returns every timing recorded since the last {@link takePerfWindow}, by category. */
export function peekPerfWindow() {
    return createCategoryReader(currentWindow.timings);
}

/** Same as {@link peekPerfWindow}, but also starts a new window. */
export function takePerfWindow() {
    const taken = currentWindow.timings;
    currentWindow.timings = new Map();
    return createCategoryReader(taken);
}
