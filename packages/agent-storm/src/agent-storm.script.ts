#!/usr/bin/env node
/**
 * `npx agent-storm`: installs the latest release when none is installed, starts it in the
 * background, and opens it in the browser.
 */

// cspell:words rundll

import {assertWrap, waitUntil} from '@augment-vir/assert';
import {extractErrorMessage, HttpStatus, log} from '@augment-vir/common';
import {currentOperatingSystem, OperatingSystem} from '@augment-vir/node';
import {convertDuration} from 'date-vir';
import {execFile, spawn} from 'node:child_process';
import {once} from 'node:events';
import {chmod, mkdir, open, readFile, rm, writeFile} from 'node:fs/promises';
import {type IncomingMessage, request as httpRequest} from 'node:http';
import {request as httpsRequest} from 'node:https';
import {connect} from 'node:net';
import {resolve} from 'node:path';
import {promisify} from 'node:util';
import {defaultPorts, PortEnvVar, readEnvPort} from './ports.js';
import {ReleaseDir} from './release-layout.js';
import {
    launcherLogPath,
    launcherOriginPath,
    pendingAuthSecretPath,
    userDataDir,
    versionsDir,
} from './user-data-paths.js';
import {
    activateVersion,
    fetchLatestVersion,
    getVersionDir,
    installRelease,
    readActiveVersions,
} from './versions.js';

const execFileAsync = promisify(execFile);

const browserOpenCommands: Readonly<
    Record<
        OperatingSystem,
        [
            string,
            ...string[],
        ]
    >
> = {
    [OperatingSystem.Mac]: [
        'open',
    ],
    [OperatingSystem.Linux]: [
        'xdg-open',
    ],
    [OperatingSystem.Windows]: [
        'rundll32',
        'url.dll,FileProtocolHandler',
    ],
};

async function isPortTaken(port: number) {
    const socket = connect(port, '127.0.0.1');
    try {
        await once(socket, 'connect');
        return true;
    } catch {
        return false;
    } finally {
        socket.destroy();
    }
}

/**
 * The launcher answers 503 until a release is serving the app. Its certificate is the user's own,
 * which may be self-signed, so it isn't verified for this check against localhost.
 */
async function isServingApp(origin: string) {
    const outgoing = origin.startsWith('https:')
        ? httpsRequest(origin, {
              rejectUnauthorized: false,
          })
        : httpRequest(origin);
    outgoing.setTimeout(
        convertDuration(
            {
                seconds: 5,
            },
            {
                milliseconds: true,
            },
        ).milliseconds,
        () => {
            outgoing.destroy();
        },
    );
    outgoing.end();
    try {
        const [response] = (await once(outgoing, 'response')) satisfies unknown[] as [
            IncomingMessage,
        ];
        response.resume();
        return response.statusCode === HttpStatus.Ok;
    } catch {
        return false;
    } finally {
        outgoing.destroy();
    }
}

/** Undefined until the launcher is listening. */
async function readLauncherOrigin() {
    try {
        return (await readFile(launcherOriginPath, 'utf8')).trim() || undefined;
    } catch {
        return undefined;
    }
}

async function readOrInstallActiveVersion() {
    const activeVersions = await readActiveVersions(versionsDir);
    if (activeVersions) {
        return activeVersions.active;
    }
    const version = await fetchLatestVersion();
    log.info(`Installing agent-storm ${version}...`);
    await installRelease({
        versionsDir,
        version,
    });
    await activateVersion({
        versionsDir,
        version,
    });
    return version;
}

/**
 * The log only holds the latest run, so everything in it is printed while waiting below. The data
 * folder holds settings and secrets, so it and the log are kept to the user.
 */
async function startLauncher(launcherPath: string) {
    await mkdir(userDataDir, {
        recursive: true,
        mode: 0o700,
    });
    await chmod(userDataDir, 0o700);
    await writeFile(launcherLogPath, '', {
        mode: 0o600,
    });
    await chmod(launcherLogPath, 0o600);
    const logFile = await open(launcherLogPath, 'a');
    try {
        spawn(
            process.execPath,
            [
                launcherPath,
            ],
            {
                detached: true,
                stdio: [
                    'ignore',
                    logFile.fd,
                    logFile.fd,
                ],
            },
        ).unref();
    } finally {
        await logFile.close();
    }
}

/** Prints what the launcher logged after `offset` and returns the new end. */
async function printLogSince(offset: number) {
    const logFile = await open(launcherLogPath, 'r');
    try {
        const {size} = await logFile.stat();
        if (size > offset) {
            const {buffer} = await logFile.read(
                Buffer.alloc(size - offset),
                0,
                size - offset,
                offset,
            );
            process.stdout.write(buffer);
        }
        return size;
    } finally {
        await logFile.close();
    }
}

/** Printed once: only its hash is kept. */
async function printPendingAuthSecret() {
    const secret = (await readFile(pendingAuthSecretPath, 'utf8').catch(() => '')).trim();
    if (!secret) {
        return;
    }
    log.info(
        [
            `auth secret: ${secret}`,
            'Save this. agent-storm only keeps its hash, so it is not shown again.',
        ].join('\n'),
    );
    await rm(pendingAuthSecretPath, {
        force: true,
    });
}

const port = readEnvPort(PortEnvVar.Backend) ?? defaultPorts[PortEnvVar.Backend];
const launcherState: {origin: string | undefined} = {
    origin: undefined,
};

if (await isPortTaken(port)) {
    launcherState.origin = (await readLauncherOrigin()) || `http://localhost:${port}`;
    log.info(`agent-storm is already running at ${launcherState.origin}`);
} else {
    const version = await readOrInstallActiveVersion();
    await rm(launcherOriginPath, {
        force: true,
    });
    await startLauncher(
        resolve(
            getVersionDir({
                versionsDir,
                version,
            }),
            ReleaseDir.Server,
            'launcher.js',
        ),
    );
    const logCursor = {
        offset: 0,
    };
    await waitUntil.isTrue(
        async () => {
            launcherState.origin = await readLauncherOrigin();
            const isServing = !!launcherState.origin && (await isServingApp(launcherState.origin));
            logCursor.offset = await printLogSince(logCursor.offset);
            return isServing;
        },
        {
            interval: {
                milliseconds: 500,
            },
            timeout: {
                minutes: 2,
            },
        },
        `agent-storm didn't start. Its output is in ${launcherLogPath}`,
    );
}

await printPendingAuthSecret();

const origin = assertWrap.isDefined(launcherState.origin);
const [
    openCommand,
    ...openArgs
] = browserOpenCommands[currentOperatingSystem];
try {
    await execFileAsync(openCommand, [
        ...openArgs,
        origin,
    ]);
} catch (error) {
    log.warning(`Open ${origin} in your browser: ${extractErrorMessage(error)}`);
}
