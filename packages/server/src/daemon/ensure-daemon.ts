import {log, wait} from '@augment-vir/common';
import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {createConnection} from 'node:net';
import {daemonScriptPath, daemonSocketPath} from '../file-paths.js';
import {fetchDaemonProtocolVersion, shutdownDaemon} from './daemon-client.js';
import {daemonProtocolVersion} from './protocol.js';

async function pingDaemon(): Promise<boolean> {
    if (!existsSync(daemonSocketPath)) {
        return false;
    }
    return await new Promise<boolean>((resolve) => {
        const socket = createConnection(daemonSocketPath);
        socket.once('connect', () => {
            socket.end();
            resolve(true);
        });
        socket.once('error', () => {
            socket.destroy();
            resolve(false);
        });
    });
}

async function waitForDaemonReady(timeoutMs: number): Promise<boolean> {
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
        if (await pingDaemon()) {
            return true;
        }
        await wait({
            milliseconds: 100,
        });
    }
    return false;
}

export async function waitForDaemonGone(timeoutMs: number): Promise<boolean> {
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
        if (!(await pingDaemon())) {
            return true;
        }
        await wait({
            milliseconds: 100,
        });
    }
    return false;
}

/**
 * Replace a running daemon whose wire contract predates this build. The daemon is detached and
 * deliberately outlives `npm start`, so after a `git pull` the process in memory is still the old
 * one while the code on disk is new — and an old daemon ignores the `sessionId` field entirely,
 * collapsing every session of a folder+kind onto a single PTY. Restarting is the only remedy: a
 * live daemon can't learn the new key format in place.
 *
 * Costs the user their in-flight PTYs exactly once, at startup, rather than letting a silently
 * mismatched pair corrupt sessions during use.
 */
async function replaceOutdatedDaemon(): Promise<boolean> {
    const runningVersion = await fetchDaemonProtocolVersion().catch(() => undefined);
    if (runningVersion === undefined) {
        /**
         * The daemon answered the socket ping but not the status probe. Treat it as unusable and
         * replace it — leaving it running would fail every subsequent attach anyway.
         */
        log.warning('PTY daemon did not report a protocol version; restarting it.');
    } else if (runningVersion >= daemonProtocolVersion) {
        return false;
    } else {
        log.warning(
            `PTY daemon speaks protocol v${runningVersion}, this build needs v${daemonProtocolVersion}; restarting it. Running panes will be terminated.`,
        );
    }
    await shutdownDaemon().catch(() => {
        /* an unresponsive daemon may not honor shutdown; the wait below decides whether it died */
    });
    const gone = await waitForDaemonGone(3000);
    if (!gone) {
        throw new Error(
            'An outdated PTY daemon is still running and did not shut down. Kill the `pty-daemon` process manually and restart.',
        );
    }
    return true;
}

export async function ensureDaemon(): Promise<void> {
    if (await pingDaemon()) {
        const replaced = await replaceOutdatedDaemon();
        if (!replaced) {
            log.info('PTY daemon already running.');
            return;
        }
    }

    log.info(`Starting PTY daemon (script: ${daemonScriptPath})...`);
    /* eslint-disable sonarjs/no-os-command-from-path -- `npx` is resolved via the developer's PATH; this CLI only runs locally. */
    const child = spawn(
        'npx',
        [
            'tsx',
            daemonScriptPath,
        ],
        {
            detached: true,
            stdio: 'ignore',
            env: process.env,
        },
    );
    /* eslint-enable sonarjs/no-os-command-from-path */
    child.unref();

    const readyTimeoutMs = 8000;
    const ready = await waitForDaemonReady(readyTimeoutMs);
    if (!ready) {
        throw new Error(
            `PTY daemon did not become ready within ${readyTimeoutMs / 1000}s. Check the daemon log for details.`,
        );
    }
    log.success('PTY daemon ready.');
}
