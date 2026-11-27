import {type MaybePromise} from '@augment-vir/common';
import {AsyncLocalStorage} from 'node:async_hooks';
import {performance} from 'node:perf_hooks';

/** Spans past this many in one trace are dropped, so a runaway loop can't grow a trace forever. */
const maxSpanCount = 2000;

/**
 * One timed step inside a {@link PerfTrace}, such as a `git` command or a SQLite query.
 *
 * @category Internal
 */
export type PerfSpan = {
    name: string;
    /** Since its trace started. */
    startMilliseconds: number;
    milliseconds: number;
    isFailed: boolean;
};

/**
 * The spans recorded while one piece of work ran, from {@link startPerfTrace}.
 *
 * @category Internal
 */
export type PerfTrace = {
    /** From `performance.now()`. */
    startedAt: number;
    spans: PerfSpan[];
    /** Spans not kept once {@link PerfTrace.spans} was full. */
    droppedSpanCount: number;
    /**
     * Set by {@link takePerfTrace}. Work the traced code started without awaiting, like a session
     * loop, keeps the trace as its async context, and its spans would otherwise pile up forever.
     */
    isEnded: boolean;
};

/** On `globalThis` because each plugin's server bundle carries its own copy of this module. */
function getPerfTraceStorage() {
    const key = Symbol.for('agent-storm.perf-trace-storage');
    const existing: unknown = Reflect.get(globalThis, key);
    if (existing instanceof AsyncLocalStorage) {
        return existing satisfies AsyncLocalStorage<unknown> as AsyncLocalStorage<PerfTrace>;
    }
    const created = new AsyncLocalStorage<PerfTrace>();
    Reflect.set(globalThis, key, created);
    return created;
}

/**
 * Runs `callback` in a new trace: every {@link tracePerfSpan} its async work reaches, in this
 * process and in plugin bundles, records into that trace until {@link takePerfTrace} ends it.
 *
 * @category Util
 */
export function startPerfTrace<Result>(callback: (trace: PerfTrace) => Result) {
    const trace: PerfTrace = {
        startedAt: performance.now(),
        spans: [],
        droppedSpanCount: 0,
        isEnded: false,
    };
    return getPerfTraceStorage().run(trace, () => callback(trace));
}

/**
 * Ends `trace` (by default the one the current async context runs in) and returns it, or
 * `undefined` outside a trace or once it was already taken.
 *
 * @category Util
 */
export function takePerfTrace(trace = getPerfTraceStorage().getStore()) {
    if (!trace || trace.isEnded) {
        return undefined;
    }
    trace.isEnded = true;
    return trace;
}

/**
 * Same as awaiting `callback()`, but records how long it took as a span of the current trace (see
 * {@link startPerfTrace}). Outside a trace it only runs `callback`, so it costs nothing while
 * tracing is off.
 *
 * @category Util
 */
export async function tracePerfSpan<Result>(name: string, callback: () => MaybePromise<Result>) {
    const trace = getPerfTraceStorage().getStore();
    if (!trace || trace.isEnded) {
        return await callback();
    }
    const startedAt = performance.now();
    function recordSpan(isFailed: boolean) {
        if (!trace || trace.isEnded) {
            return;
        } else if (trace.spans.length >= maxSpanCount) {
            trace.droppedSpanCount++;
            return;
        }
        /** Mutated in place: a trace can collect thousands of spans, one per query. */
        trace.spans.push({
            name,
            startMilliseconds: startedAt - trace.startedAt,
            milliseconds: performance.now() - startedAt,
            isFailed,
        });
    }
    try {
        const result = await callback();
        recordSpan(false);
        return result;
    } catch (error) {
        recordSpan(true);
        throw error;
    }
}
