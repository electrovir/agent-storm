import {type SpawnedProcess, type SpawnOptions} from '@anthropic-ai/claude-agent-sdk';
import {extractErrorMessage} from '@augment-vir/common';
import {EventEmitter} from 'node:events';
import {PassThrough, Writable} from 'node:stream';
import {filterStringEnv, type ProviderProcessHost} from './provider-session.js';

/**
 * Same as the Claude CLI process the SDK spawns itself, but the process runs in Agent Storm's
 * daemon and outlives this server. A later session attaching the same way takes over the running
 * CLI, which repeats any permission request it still waits on when the new session initializes.
 *
 * `kill` does nothing and closing stdin doesn't reach the CLI: the SDK does both whenever its query
 * closes, including when this server shuts down. Only the host's kill stops the CLI.
 */
export function spawnHostedClaudeProcess({
    processHost,
    spawnOptions: {command, args, cwd, env},
}: Readonly<{
    processHost: ProviderProcessHost;
    spawnOptions: Readonly<SpawnOptions>;
}>): SpawnedProcess {
    /** The SDK listens with Node's `on` / `once` / `off`, which `EventTarget` lacks. */
    // eslint-disable-next-line unicorn/prefer-event-target
    const events = new EventEmitter();
    const stdout = new PassThrough();
    const state = {
        isFinished: false,
    };

    function finish(exitCode: number | null, signal: string | null) {
        if (state.isFinished) {
            return;
        }
        state.isFinished = true;
        spawned.exitCode = exitCode;
        stdout.end();
        events.emit('exit', exitCode, signal);
    }

    const attachment = processHost
        .attach({
            spawn: {
                command,
                args,
                cwd: cwd || process.cwd(),
                env: filterStringEnv(env),
            },
            onStdout(data) {
                stdout.write(data);
            },
            onExit({exitCode, signal, stderr}) {
                if (stderr.trim()) {
                    events.emit('error', new Error(stderr.trim()));
                }
                finish(exitCode, signal);
            },
        })
        .catch((error: unknown) => {
            events.emit(
                'error',
                new Error(`Starting Claude in the daemon failed: ${extractErrorMessage(error)}`),
            );
            finish(1, null);
            return undefined;
        });

    /** Writes made before the daemon answers wait for it, in order. */
    const stdin = new Writable({
        write(chunk: Buffer, _encoding, callback) {
            void attachment.then((attached) => attached?.write(chunk));
            callback();
        },
    });

    const spawned: Omit<SpawnedProcess, 'exitCode'> & {exitCode: number | null} = {
        stdin,
        stdout,
        killed: false,
        exitCode: null,
        kill() {
            void attachment.then((attached) => {
                attached?.detach();
                finish(null, 'SIGTERM');
            });
            return true;
        },
        on: events.on.bind(events),
        once: events.once.bind(events),
        off: events.off.bind(events),
    };
    return spawned;
}
