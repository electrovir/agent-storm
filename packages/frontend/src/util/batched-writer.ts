import {type ValueUpdate} from '@agent-storm/core/frontend';
import {type MaybePromise} from '@augment-vir/common';
import {convertDuration, type AnyDuration} from 'date-vir';

/**
 * Collects edits to one stored value and writes them together once edits stop arriving for `delay`.
 * Each write re-reads the stored value and applies every collected edit to it in order, so edits
 * made elsewhere since the last read survive. Writes never overlap.
 */
export function createBatchedWriter<Value>({
    delay,
    read,
    write,
    onSaved,
    onError,
}: Readonly<{
    delay: Readonly<AnyDuration>;
    read: () => Promise<Value>;
    /** Resolves to the value as stored, which may differ from what was sent. */
    write: (value: Value) => Promise<Value>;
    /** `pending` holds the edits that arrived while this write was in flight. */
    onSaved: (
        params: Readonly<{
            previous: Value;
            saved: Value;
            pending: ReadonlyArray<ValueUpdate<Value>>;
        }>,
    ) => MaybePromise<void>;
    onError: (error: unknown) => void;
}>) {
    const queue: {
        pending: ReadonlyArray<ValueUpdate<Value>>;
        timeout: ReturnType<typeof setTimeout> | undefined;
        lastWrite: Promise<void>;
    } = {
        pending: [],
        timeout: undefined,
        lastWrite: Promise.resolve(),
    };

    async function writePending() {
        const updates = queue.pending;
        queue.pending = [];
        if (!updates.length) {
            return;
        }
        try {
            const previous = await read();
            const saved = await write(
                updates.reduce((value: Value, update) => update(value), previous),
            );
            await onSaved({
                previous,
                saved,
                pending: queue.pending,
            });
        } catch (error) {
            onError(error);
        }
    }

    /** Writes every collected edit now, after any write already in flight. */
    async function flush() {
        clearTimeout(queue.timeout);
        queue.timeout = undefined;
        queue.lastWrite = queue.lastWrite.then(writePending);
        await queue.lastWrite;
    }

    return {
        add(update: ValueUpdate<Value>) {
            queue.pending = [
                ...queue.pending,
                update,
            ];
            clearTimeout(queue.timeout);
            queue.timeout = setTimeout(
                () => void flush(),
                convertDuration(delay, {
                    milliseconds: true,
                }).milliseconds,
            );
        },
        flush,
    };
}
