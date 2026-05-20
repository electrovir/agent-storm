import {log, wait} from '@augment-vir/common';
import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {createConnection} from 'node:net';
import {fileURLToPath} from 'node:url';
import {daemonSocketPath} from './daemon-paths.js';

const daemonScriptPath = fileURLToPath(new URL('./pty-daemon.ts', import.meta.url));

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
        await wait({milliseconds: 100});
    }
    return false;
}

export async function waitForDaemonGone(timeoutMs: number): Promise<boolean> {
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
        if (!(await pingDaemon())) {
            return true;
        }
        await wait({milliseconds: 100});
    }
    return false;
}

export async function ensureDaemon(): Promise<void> {
    if (await pingDaemon()) {
        log.info('PTY daemon already running.');
        return;
    }

    log.info(`Starting PTY daemon (script: ${daemonScriptPath})...`);
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
    child.unref();

    const readyTimeoutMs = 8_000;
    const ready = await waitForDaemonReady(readyTimeoutMs);
    if (!ready) {
        throw new Error(
            `PTY daemon did not become ready within ${readyTimeoutMs / 1_000}s. Check the daemon log for details.`,
        );
    }
    log.success('PTY daemon ready.');
}
