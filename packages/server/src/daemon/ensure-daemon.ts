import {log, wait} from '@augment-vir/common';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {existsSync} from 'node:fs';
import {createConnection} from 'node:net';
import {dirname, join} from 'node:path';
import {daemonScriptPath, daemonSocketPath} from '../file-paths.js';

/**
 * tsx 4.22+ removed `./dist/cli.mjs` from its package `exports`, so we can no longer ask
 * `require.resolve` for that subpath directly. `./package.json` is still exported, so we resolve
 * that, read the `bin` field, and join the two.
 */
const require = createRequire(import.meta.url);
const tsxPackageJsonPath = require.resolve('tsx/package.json');
const tsxBin = (require(tsxPackageJsonPath) as {bin: string}).bin;
const tsxCliPath = join(dirname(tsxPackageJsonPath), tsxBin);

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

export async function ensureDaemon(): Promise<void> {
    if (await pingDaemon()) {
        log.info('PTY daemon already running.');
        return;
    }

    log.info(`Starting PTY daemon (script: ${daemonScriptPath})...`);
    /* eslint-disable sonarjs/no-os-command-from-path -- `npx` is resolved via the developer's PATH; this CLI only runs locally. */
    const child = spawn(
        process.execPath,
        [
            tsxCliPath,
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

    const readyTimeoutMs = 30_000;
    const ready = await waitForDaemonReady(readyTimeoutMs);
    if (!ready) {
        throw new Error(
            `PTY daemon did not become ready within ${readyTimeoutMs / 1000}s. Check the daemon log for details.`,
        );
    }
    log.success('PTY daemon ready.');
}
