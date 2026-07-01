import {spawn, type ChildProcess} from 'node:child_process';

/**
 * Per-worktree dev-server child manager. Powers the "Test locally" action on the Self-QA step:
 * spawn `npm start` once per worktree, parse the frontend port out of its stdout/stderr, and
 * keep the process alive so subsequent clicks reuse the same port.
 *
 * Lifetime model:
 *   - First `ensureTestServer(worktreePath)` call spawns the child and resolves once a
 *     `http://localhost:<port>` (or 127.0.0.1) line shows up in its output. 60s timeout.
 *   - Subsequent calls for the same worktree return the cached port immediately, even across
 *     reconnects of the frontend client.
 *   - If the child exits before a port is detected, the cache entry is dropped and the next
 *     call respawns; this lets the user retry after fixing whatever made `npm start` fail.
 *   - On agent-storm shutdown, every child is killed by its process-group leader (we spawn
 *     with `detached: true` so a single `process.kill(-pid)` reaps the whole tree, including
 *     anything `npm start` itself forked — vite, electron-watch, etc.).
 */

type TestServerEntry = {
    child: ChildProcess;
    pid: number;
    /** Resolved with the detected port once the child prints a localhost URL. */
    portPromise: Promise<number>;
    /** Resolved port, available after the child reports a URL. Undefined until then. */
    port: number | undefined;
    /** Last ~8KB of combined stdout/stderr, kept around so errors surface useful context. */
    outputTail: string;
};

const servers = new Map<string, TestServerEntry>();

/**
 * Matches the first `http://localhost:<port>` or `http://127.0.0.1:<port>` URL printed by
 * the child. Covers vite ("Local: http://localhost:5173/"), Next.js ("ready - started server
 * on http://localhost:3000"), Express's morgan logs, and the agent-storm `npm start` banner.
 */
const portLineRegex = /https?:\/\/(?:localhost|127\.0\.0\.1):(\d+)/;

const portTimeoutMs = 60_000;
const outputTailMax = 8_000;

export async function ensureTestServer(
    worktreePath: string,
): Promise<{port: number; reused: boolean}> {
    const existing = servers.get(worktreePath);
    if (existing) {
        const port = existing.port ?? (await existing.portPromise);
        return {port, reused: true};
    }
    const entry = startTestServer(worktreePath);
    servers.set(worktreePath, entry);
    const port = await Promise.race([
        entry.portPromise,
        new Promise<number>((_, reject) => {
            setTimeout(() => {
                reject(
                    new Error(
                        `Timed out after ${portTimeoutMs / 1000}s waiting for npm start to ` +
                            `print a localhost URL.\n\nLast output:\n${entry.outputTail}`,
                    ),
                );
            }, portTimeoutMs);
        }),
    ]).catch((error: unknown) => {
        // Failed start → drop the entry so the next click respawns rather than hitting the
        // same dead process.
        servers.delete(worktreePath);
        killTree(entry.pid);
        throw error;
    });
    return {port, reused: false};
}

function startTestServer(worktreePath: string): TestServerEntry {
    /**
     * `detached: true` puts the child in its own process group; the resulting `pid` doubles
     * as the negative pid we need to kill the whole tree later. `shell: true` lets us launch
     * via the user's PATH-resolved `npm` (matching what they'd run themselves) without
     * resolving it ourselves.
     */
    const child = spawn('npm', ['start'], {
        cwd: worktreePath,
        detached: true,
        stdio: [
            'ignore',
            'pipe',
            'pipe',
        ],
        env: process.env,
    });

    const pid = child.pid;
    if (!pid) {
        throw new Error(`Failed to spawn npm start in ${worktreePath}`);
    }

    let resolvePort!: (port: number) => void;
    let rejectPort!: (error: Error) => void;
    const portPromise = new Promise<number>((resolve, reject) => {
        resolvePort = resolve;
        rejectPort = reject;
    });

    const entry: TestServerEntry = {
        child,
        pid,
        portPromise,
        port: undefined,
        outputTail: '',
    };

    const handleOutput = (chunk: Buffer) => {
        const text = chunk.toString();
        entry.outputTail = (entry.outputTail + text).slice(-outputTailMax);
        if (entry.port !== undefined) {
            return;
        }
        const match = portLineRegex.exec(text);
        if (match) {
            const detected = Number.parseInt(match[1]!, 10);
            if (Number.isInteger(detected) && detected > 0 && detected <= 65_535) {
                entry.port = detected;
                resolvePort(detected);
            }
        }
    };
    child.stdout?.on('data', handleOutput);
    child.stderr?.on('data', handleOutput);

    child.on('exit', (code, signal) => {
        if (entry.port === undefined) {
            rejectPort(
                new Error(
                    `npm start exited (code=${code}, signal=${signal}) before a port URL ` +
                        `appeared.\n\nLast output:\n${entry.outputTail}`,
                ),
            );
        }
        servers.delete(worktreePath);
    });

    child.on('error', (error) => {
        if (entry.port === undefined) {
            rejectPort(error);
        }
    });

    return entry;
}

/**
 * Kill a detached child *and its descendants* by signalling the process-group leader. The
 * `-pid` form sends the signal to every process whose PGID is `pid`, which `detached: true`
 * established when we spawned the child. Swallow ESRCH (already dead) and EPERM (we lost the
 * right to signal it, e.g. the child setsid'd into a separate group) — both leave nothing
 * useful to do.
 */
function killTree(pid: number): void {
    try {
        process.kill(-pid, 'SIGTERM');
    } catch {
        /* already gone or unsignalable — drop */
    }
}

/**
 * Iterate every live entry and reap its process group. Wired into the server's exit hooks so
 * `npm start` children don't outlive agent-storm.
 */
export function shutdownAllTestServers(): void {
    for (const entry of servers.values()) {
        killTree(entry.pid);
    }
    servers.clear();
}

/**
 * One-time install of `exit` / `SIGTERM` / `SIGINT` handlers that flush every spawned test
 * server. Idempotent — repeated calls are no-ops.
 */
let shutdownHooksInstalled = false;
export function installShutdownHooks(): void {
    if (shutdownHooksInstalled) {
        return;
    }
    shutdownHooksInstalled = true;
    const handler = () => {
        shutdownAllTestServers();
    };
    process.once('exit', handler);
    process.once('SIGTERM', handler);
    process.once('SIGINT', handler);
}
