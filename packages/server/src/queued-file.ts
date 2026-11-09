import {extractErrorMessage, log, PromiseQueue} from '@augment-vir/common';

/**
 * Serializes every write to one stored file. Without it, two requests that each load, modify, and
 * save the file interleave and the later save silently drops the earlier one's change.
 */
export function createQueuedFile<T>({
    description,
    load,
    write,
}: Readonly<{
    /** Names the file in the warning logged when it can't be read. */
    description: string;
    load: () => Promise<T>;
    write: (value: Readonly<T>) => Promise<void>;
}>) {
    const queue = new PromiseQueue();
    /**
     * Load, modify, and save the file as one queued step. Skips the write when `change` returns
     * `undefined` or when the file can't be read, so a transient read failure never resets it.
     */
    async function update(change: (current: Readonly<T>) => T | undefined) {
        await queue.add(async () => {
            const current = await load().catch((error: unknown) => {
                log.warning(
                    `Not updating ${description}, it can't be read: ${extractErrorMessage(error)}`,
                );
                return undefined;
            });
            const updated = current && change(current);
            if (updated) {
                await write(updated);
            }
        });
    }
    /** Replaces the file. Runs after any queued {@link update} calls finish. */
    async function save(value: Readonly<T>) {
        await queue.add(async () => await write(value));
    }
    return {
        save,
        update,
    };
}
