// cspell:words pgroup, pgid

import {spawn, type ChildProcess} from 'node:child_process';
import {appendFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join, resolve} from 'node:path';
import {daemonLogPath} from '../file-paths.js';
import {type VscodeListEntry} from './protocol.js';

function log(message: string): void {
    try {
        appendFileSync(daemonLogPath, `[${new Date().toISOString()}] [vscode] ${message}\n`);
    } catch {
        /* swallow log errors so they never crash the daemon */
    }
}

function normalizeFolder(folder: string): string {
    const expanded =
        folder === '~'
            ? homedir()
            : folder.startsWith('~/')
              ? join(homedir(), folder.slice(2))
              : folder;
    return resolve(expanded);
}

type VscodeEntry = {
    child: ChildProcess;
    port: number;
    basePath: string;
    /** Resolves once `port` is known (we parse it out of `code serve-web`'s stdout). */
    ready: Promise<number>;
};

const instances = new Map<string, VscodeEntry>();

/**
 * How long we wait for `code serve-web` to print its "Web UI available at http://127.0.0.1:<port>"
 * banner. The process can be slow on first launch when it's downloading the server bits, so the
 * timeout is generous.
 */
const startupTimeoutMs = 60_000;

function entryIsAlive(entry: VscodeEntry): boolean {
    return !entry.child.killed && entry.child.exitCode === null;
}

/**
 * Signal the whole process group rooted at `child` so the bash wrapper + the nested code-tunnel +
 * the actual `node server-main.js` all die together. Falls back to a direct `child.kill()` if
 * pgroup signaling fails (e.g. child has already exited and its pgid was reaped).
 */
function killEntryGroup(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): void {
    if (typeof child.pid === 'number') {
        try {
            process.kill(-child.pid, signal);
            return;
        } catch {
            /* fall through to child.kill */
        }
    }
    child.kill(signal);
}

function spawnVscode(folder: string, basePath: string): VscodeEntry {
    const normalized = normalizeFolder(folder);
    /**
     * `--without-connection-token` is safe here because the agent-storm backend wraps this server
     * with a bearer-auth proxy — `code serve-web` itself is only ever reached via the proxy.
     * `--host 127.0.0.1` keeps the actual server reachable only from this machine. `--port 0` asks
     * the OS for a free port; we parse it out of stdout below. `--server-base-path` is what makes
     * the asset URLs in the served HTML resolve correctly when the iframe is mounted under the
     * backend's `/vscode-proxy/<id>` prefix.
     */
    const args = [
        'serve-web',
        '--without-connection-token',
        '--accept-server-license-terms',
        '--host',
        '127.0.0.1',
        '--port',
        '0',
    ];
    if (basePath) {
        args.push('--server-base-path', basePath);
    }
    /**
     * `detached: true` makes the spawned `code` process a new process-group leader. The `code`
     * binary is a bash wrapper that exec's `code-tunnel` which itself spawns the actual `node
     * server-main.js`. Without a dedicated process group, `child.kill()` only signals the outer
     * bash — which doesn't forward signals to its descendants — and the node server-main orphans
     * and keeps listening on its port. By making the child its own pgroup leader, we can
     * `process.kill(-pid, signal)` to deliver the signal to every process in the group at once,
     * tearing the whole VS Code tree down cleanly.
     */
    // eslint-disable-next-line sonarjs/no-os-command-from-path
    const child = spawn('code', args, {
        cwd: normalized,
        env: process.env,
        stdio: [
            'ignore',
            'pipe',
            'pipe',
        ],
        detached: true,
    });

    /**
     * Critical: we must keep reading stdout/stderr for the lifetime of the child, even after we
     * already have the port. If we remove the listener, the OS-level pipe (default ~64KB on macOS)
     * fills with later log output and VS Code's worker threads BLOCK in a write syscall trying to
     * flush. Symptom looks identical to "the server stopped responding" — the TCP listener still
     * accepts connections but never produces an HTTP response. So instead of detaching the listener
     * on port discovery, we just stop matching against the buffer.
     */
    const entry: VscodeEntry = {
        child,
        port: 0,
        basePath,
        ready: new Promise<number>((resolvePort, rejectPort) => {
            let buffer = '';
            let resolved = false;
            const onChunk = (data: Buffer | string) => {
                const text = data.toString();
                if (!resolved) {
                    buffer += text;
                    const match = buffer.match(/127\.0\.0\.1:(\d+)/);
                    if (match?.[1]) {
                        const port = Number.parseInt(match[1], 10);
                        if (Number.isFinite(port)) {
                            resolved = true;
                            buffer = '';
                            entry.port = port;
                            resolvePort(port);
                        }
                    }
                }
                /**
                 * Drain & discard once resolved; the listener stays attached for the child's life.
                 * Temporarily mirroring upstream output to the daemon log so we can see what `code
                 * serve-web` says about incoming requests during WS handshake debugging.
                 */
                text.split('\n').forEach((line) => {
                    const trimmed = line.trim();
                    if (trimmed) {
                        log(`[vscode-out] ${trimmed}`);
                    }
                });
            };
            child.stdout.on('data', onChunk);
            child.stderr.on('data', onChunk);
            const timeout = setTimeout(() => {
                if (!resolved) {
                    rejectPort(
                        new Error(
                            `code serve-web did not print a port within ${startupTimeoutMs / 1000}s`,
                        ),
                    );
                }
            }, startupTimeoutMs);
            child.once('exit', (code, signal) => {
                clearTimeout(timeout);
                if (!resolved) {
                    rejectPort(
                        new Error(
                            `code serve-web exited before printing a port (code=${code}, signal=${signal})`,
                        ),
                    );
                }
            });
        }),
    };

    child.on('exit', (code, signal) => {
        log(`vscode for ${normalized} exited (code=${code}, signal=${signal})`);
        const current = instances.get(normalized);
        if (current === entry) {
            instances.delete(normalized);
        }
    });
    child.on('error', (error) => {
        log(`vscode for ${normalized} spawn error: ${error.message}`);
    });

    return entry;
}

export async function ensureVscode(folder: string, basePath: string): Promise<number> {
    const normalized = normalizeFolder(folder);
    const existing = instances.get(normalized);
    if (existing && entryIsAlive(existing) && existing.basePath === basePath) {
        return existing.port || (await existing.ready);
    }
    /**
     * If the base path changed (very unlikely but possible if the backend's URL scheme is updated
     * across a restart while a VS Code instance is still alive), kill the stale process before
     * spawning fresh — otherwise the iframe URL would 404.
     */
    if (existing) {
        killEntryGroup(existing.child);
        instances.delete(normalized);
    }
    log(`spawning vscode for ${normalized} (basePath=${basePath || '/'})`);
    const entry = spawnVscode(normalized, basePath);
    instances.set(normalized, entry);
    return entry.ready;
}

export function killVscode(folder: string): boolean {
    const normalized = normalizeFolder(folder);
    const entry = instances.get(normalized);
    if (!entry) {
        return false;
    }
    log(`killing vscode for ${normalized}`);
    killEntryGroup(entry.child);
    instances.delete(normalized);
    return true;
}

export function listVscode(): VscodeListEntry[] {
    return Array.from(
        instances.entries(),
        ([
            folder,
            entry,
        ]) => ({
            folder,
            port: entry.port,
            basePath: entry.basePath,
        }),
    ).filter((entry) => entry.port > 0);
}

export function killAllVscode(): void {
    instances.forEach((entry) => killEntryGroup(entry.child));
    instances.clear();
}
