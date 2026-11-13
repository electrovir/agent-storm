import {check} from '@augment-vir/assert';
import {extractErrorMessage, log, type MaybePromise} from '@augment-vir/common';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {checkValidShape, defineShape, optionalShape, unknownShape} from 'object-shape-tester';

/**
 * One line `codex app-server` writes: a response to our request, a request of its own, or a
 * notification. Its messages leave out the `"jsonrpc"` field.
 */
const codexMessageShape = defineShape({
    id: optionalShape(unknownShape(), {
        alsoUndefined: true,
    }),
    method: optionalShape('', {
        alsoUndefined: true,
    }),
    params: optionalShape(unknownShape(), {
        alsoUndefined: true,
    }),
    result: optionalShape(unknownShape(), {
        alsoUndefined: true,
    }),
    error: optionalShape(
        defineShape({
            message: '',
        }),
        {
            alsoUndefined: true,
        },
    ),
});

/** A connection to a `codex app-server` process, which speaks JSON-RPC over stdio. */
export type CodexRpc = ReturnType<typeof startCodexRpc>;

/**
 * Starts `codex app-server` in `cwd`. Answers each of its requests with `onRequest`'s result, or an
 * error when that throws.
 */
export function startCodexRpc({
    cwd,
    onNotification,
    onRequest,
    onExit,
}: Readonly<{
    cwd: string;
    onNotification(method: string, params: unknown): MaybePromise<void>;
    onRequest(method: string, params: unknown): Promise<unknown>;
    onExit(reason: string): void;
}>) {
    const child = spawn(
        /** Codex installs in too many places to pin a path, so it's found the way a shell finds it. */
        // eslint-disable-next-line sonarjs/no-os-command-from-path
        'codex',
        [
            'app-server',
        ],
        {
            cwd,
            stdio: [
                'pipe',
                'pipe',
                'pipe',
            ],
        },
    );
    const pending = new Map<
        number,
        {
            resolve(result: unknown): void;
            reject(error: Error): void;
        }
    >();
    const state = {
        nextId: 1,
        isExited: false,
        stderr: '',
    };

    function write(message: Readonly<Record<string, unknown>>) {
        if (!state.isExited) {
            child.stdin.write(`${JSON.stringify(message)}\n`);
        }
    }

    function exit(reason: string) {
        if (state.isExited) {
            return;
        }
        state.isExited = true;
        pending.forEach((entry) => entry.reject(new Error(reason)));
        pending.clear();
        onExit(reason);
    }

    child.stderr.on('data', (chunk: Buffer) => {
        /** Keeps only the end, to explain an exit without holding every log line. */
        state.stderr = (state.stderr + chunk.toString()).slice(-2000);
    });
    child.on('error', (error) => exit(`Codex failed to start: ${extractErrorMessage(error)}`));
    child.on('exit', (code, signal) => {
        const exitCause = signal || `code ${code}`;
        exit(
            [
                `Codex exited (${exitCause}).`,
                state.stderr.trim(),
            ]
                .filter(Boolean)
                .join('\n'),
        );
    });

    async function answerRequest({
        id,
        method,
        params,
    }: Readonly<{
        id: unknown;
        method: string;
        params: unknown;
    }>) {
        try {
            write({
                id,
                result: await onRequest(method, params),
            });
        } catch (error) {
            write({
                id,
                error: {
                    code: -32_000,
                    message: extractErrorMessage(error),
                },
            });
        }
    }

    async function handleLine(line: string) {
        const message: unknown = JSON.parse(line);
        if (
            !checkValidShape(message, codexMessageShape, {
                allowExtraKeys: true,
            })
        ) {
            return;
        }
        if (message.method == undefined) {
            const waiting = check.isNumber(message.id) ? pending.get(message.id) : undefined;
            if (waiting && check.isNumber(message.id)) {
                pending.delete(message.id);
                if (message.error) {
                    waiting.reject(new Error(message.error.message));
                } else {
                    waiting.resolve(message.result);
                }
            }
        } else if (message.id == undefined) {
            await onNotification(message.method, message.params);
        } else {
            /**
             * Not awaited: an approval request waits on the user, and the notifications behind it
             * must keep flowing meanwhile.
             */
            void answerRequest({
                id: message.id,
                method: message.method,
                params: message.params,
            });
        }
    }

    /**
     * Lines are handled one at a time, in order, since a handler writes to the database and a later
     * line (such as a delta) depends on what an earlier one (its item's start) wrote.
     */
    const lineQueue = {
        current: Promise.resolve(),
    };
    createInterface({
        input: child.stdout,
    }).on('line', (line) => {
        lineQueue.current = lineQueue.current.then(async () => {
            try {
                await handleLine(line);
            } catch (error) {
                log.error(
                    `Build V2 failed to handle a Codex message: ${extractErrorMessage(error)}`,
                );
            }
        });
    });

    return {
        async request(method: string, params: unknown) {
            if (state.isExited) {
                throw new Error('Codex is not running.');
            }
            const id = state.nextId++;
            const result = new Promise<unknown>((resolve, reject) => {
                pending.set(id, {
                    resolve,
                    reject,
                });
            });
            write({
                id,
                method,
                params,
            });
            return await result;
        },
        notify(method: string, params?: unknown) {
            write({
                method,
                ...(params == undefined
                    ? {}
                    : {
                          params,
                      }),
            });
        },
        stop() {
            child.kill();
        },
    };
}
