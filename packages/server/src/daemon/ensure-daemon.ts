import {waitUntil} from '@augment-vir/assert';
import {log} from '@augment-vir/common';
import {convertDuration, type AnyDuration} from 'date-vir';
import {spawn} from 'node:child_process';
import {createConnection} from 'node:net';
import {daemonScriptPath, daemonSocket} from '../file-paths.js';
import {fetchDaemonProtocolVersion, shutdownDaemon} from './daemon-client.js';
import {daemonProtocolVersion} from './protocol.js';

/** A wedged daemon can accept nothing, and a connect that never settles would hang every poll. */
const pingTimeout: AnyDuration = {
    seconds: 1,
};

async function pingDaemon(): Promise<boolean> {
    return await new Promise<boolean>((resolve) => {
        const socket = createConnection({
            path: daemonSocket.path,
            timeout: convertDuration(pingTimeout, {
                milliseconds: true,
            }).milliseconds,
        });
        socket.once('connect', () => {
            socket.end();
            resolve(true);
        });
        socket.once('timeout', () => {
            socket.destroy();
            resolve(false);
        });
        socket.once('error', () => {
            socket.destroy();
            resolve(false);
        });
    });
}

/**
 * Polls the daemon socket until it answers as `isUp` expects. Resolves false when `timeout` passes
 * first.
 */
async function waitForDaemonPing({
    isUp,
    timeout,
}: Readonly<{
    isUp: boolean;
    timeout: Readonly<AnyDuration>;
}>) {
    try {
        await waitUntil.strictEquals(isUp, () => pingDaemon(), {
            timeout,
        });
        return true;
    } catch {
        return false;
    }
}

export async function waitForDaemonGone(timeout: Readonly<AnyDuration>) {
    return await waitForDaemonPing({
        isUp: false,
        timeout,
    });
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
    if (runningVersion == undefined) {
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
    const gone = await waitForDaemonPing({
        isUp: false,
        timeout: {
            seconds: 3,
        },
    });
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
    /**
     * Node itself rather than `npx tsx`: Windows can't spawn `npx`, a `.cmd` script, without a
     * shell.
     */
    const child = spawn(
        process.execPath,
        [
            '--import',
            import.meta.resolve('tsx'),
            daemonScriptPath,
        ],
        {
            detached: true,
            stdio: 'ignore',
            /** A detached process on Windows otherwise opens its own console window. */
            windowsHide: true,
            env: process.env,
        },
    );
    child.unref();

    const readyTimeout: AnyDuration = {
        seconds: 8,
    };
    const ready = await waitForDaemonPing({
        isUp: true,
        timeout: readyTimeout,
    });
    if (!ready) {
        throw new Error(
            `PTY daemon did not become ready within ${
                convertDuration(readyTimeout, {
                    seconds: true,
                }).seconds
            }s. Check the daemon log for details.`,
        );
    }
    log.success('PTY daemon ready.');
}
