import {check} from '@augment-vir/assert';
import {extractErrorMessage, log, type MaybePromise} from '@augment-vir/common';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {PassThrough} from 'node:stream';
import {checkValidShape, defineShape, optionalShape, unknownShape} from 'object-shape-tester';
import {filterStringEnv, type ProviderProcessHost} from './provider-session.js';

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

/** A connection to a `codex app-server` process. */
export type CodexRpc = Awaited<ReturnType<typeof startCodexRpc>>;

const codexArgs = [
    'app-server',
];

/** Same as the daemon-hosted `codex app-server`, but a child of this server that stops with it. */
function spawnLocalCodex({
    cwd,
    env,
    onStdout,
    onExit,
}: Readonly<{
    cwd: string;
    env: Record<string, string> | undefined;
    onStdout(data: Buffer): void;
    onExit(exit: Readonly<{exitCode: number | null; signal: string | null; stderr: string}>): void;
}>) {
    const child = spawn(
        /** Codex installs in too many places to pin a path, so it's found the way a shell finds it. */
        // eslint-disable-next-line sonarjs/no-os-command-from-path
        'codex',
        codexArgs,
        {
            cwd,
            env,
            stdio: [
                'pipe',
                'pipe',
                'pipe',
            ],
        },
    );
    const state = {
        stderr: '',
    };
    child.stdout.on('data', onStdout);
    child.stderr.on('data', (chunk: Buffer) => {
        /** Keeps only the end, to explain an exit without holding every log line. */
        state.stderr = (state.stderr + chunk.toString()).slice(-2000);
    });
    child.on('error', (error) => {
        onExit({
            exitCode: null,
            signal: null,
            stderr: `Codex failed to start: ${extractErrorMessage(error)}`,
        });
    });
    child.on('exit', (exitCode, signal) => {
        onExit({
            exitCode,
            signal,
            stderr: state.stderr,
        });
    });
    return {
        isNew: true,
        write(data: string) {
            child.stdin.write(data);
        },
        detach() {
            child.kill();
        },
    };
}

/**
 * Starts `codex app-server` in `cwd`, in the daemon when `processHost` is set, where it may already
 * be running from before this server restarted. Answers each of its requests with `onRequest`'s
 * result, or an error when that throws.
 */
export async function startCodexRpc({
    cwd,
    env,
    processHost,
    onNotification,
    onRequest,
    onExit,
}: Readonly<{
    cwd: string;
    /** Replaces the environment Codex runs with. Unset inherits the server's. */
    env?: Record<string, string> | undefined;
    processHost?: ProviderProcessHost | undefined;
    onNotification(method: string, params: unknown): MaybePromise<void>;
    onRequest(method: string, params: unknown): Promise<unknown>;
    onExit(reason: string): void;
}>) {
    const pending = new Map<
        number,
        {
            resolve(result: unknown): void;
            reject(error: Error): void;
        }
    >();
    const state = {
        /**
         * Starts past any id a previous server used with the same process, so a late response to
         * one of its requests can't settle one of these.
         */
        nextId: Date.now(),
        isExited: false,
    };
    const stdout = new PassThrough();

    function handleExit({
        exitCode,
        signal,
        stderr,
    }: Readonly<{exitCode: number | null; signal: string | null; stderr: string}>) {
        const exitCause = signal || (exitCode == undefined ? 'disconnected' : `code ${exitCode}`);
        exit(
            [
                `Codex exited (${exitCause}).`,
                stderr.trim(),
            ]
                .filter(Boolean)
                .join('\n'),
        );
    }

    const connection = processHost
        ? await processHost.attach({
              spawn: {
                  command: 'codex',
                  args: codexArgs,
                  cwd,
                  env: env || filterStringEnv(process.env),
              },
              isJsonRpc: true,
              onStdout(data) {
                  stdout.write(data);
              },
              onExit: handleExit,
          })
        : spawnLocalCodex({
              cwd,
              env,
              onStdout(data) {
                  stdout.write(data);
              },
              onExit: handleExit,
          });

    function write(message: Readonly<Record<string, unknown>>) {
        if (!state.isExited) {
            connection.write(`${JSON.stringify(message)}\n`);
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
        input: stdout,
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
        /** False when Codex was already running, so it has been initialized and has the thread. */
        isNew: connection.isNew,
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
        /** Lets go of Codex. Stops it unless it runs in the daemon. */
        stop() {
            connection.detach();
            exit('Codex was stopped.');
        },
    };
}
