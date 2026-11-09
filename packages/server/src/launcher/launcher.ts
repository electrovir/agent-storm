import {waitUntil} from '@augment-vir/assert';
import {extractErrorMessage, log} from '@augment-vir/common';
import {
    activateVersion,
    getVersionDir,
    launcherOriginPath,
    PortEnvVar,
    readActiveVersions,
    rejectVersion,
    ReleaseDir,
    versionsDir,
    writeFileAtomically,
} from 'agent-storm';
import {convertDuration} from 'date-vir';
import {type ChildProcess, spawn} from 'node:child_process';
import {once} from 'node:events';
import {createServer as createHttpServer} from 'node:http';
import {createServer as createHttpsServer} from 'node:https';
import {type AddressInfo, createServer as createNetServer} from 'node:net';
import {resolve} from 'node:path';
import {type Duplex} from 'node:stream';
import {checkValidShape} from 'object-shape-tester';
import {launcherOriginEnvVar, launcherSwitchRequestShape} from '../release-build.js';
import {readPublicAddress} from './public-address.js';
import {proxyRequest, proxyUpgrade} from './reverse-proxy.js';

/**
 * Runs the active installed release behind a proxy that owns the browser's port, so the release
 * underneath can be swapped without the browser's URL changing. A release that fails to start is
 * rejected and the version before it runs instead.
 */

type RunningServer = {
    version: string;
    port: number;
    process: ChildProcess;
};

const launcherState: {
    server: RunningServer | undefined;
    isSwitching: boolean;
} = {
    server: undefined,
    isSwitching: false,
};

const publicAddress = await readPublicAddress();

async function findFreePort() {
    const probe = createNetServer();
    probe.listen(0, '127.0.0.1');
    await once(probe, 'listening');
    const {port} = probe.address() satisfies string | AddressInfo | null as AddressInfo;
    probe.close();
    await once(probe, 'close');
    return port;
}

async function isServingApp(port: number) {
    try {
        const response = await fetch(`http://127.0.0.1:${port}/`, {
            signal: AbortSignal.timeout(
                convertDuration(
                    {
                        seconds: 5,
                    },
                    {
                        milliseconds: true,
                    },
                ).milliseconds,
            ),
        });
        return response.ok;
    } catch {
        return false;
    }
}

async function stopServer(server: Readonly<RunningServer>) {
    if (server.process.exitCode != undefined || server.process.signalCode != undefined) {
        return;
    }
    const exited = once(server.process, 'exit');
    server.process.kill('SIGTERM');
    const killTimer = setTimeout(
        () => {
            server.process.kill('SIGKILL');
        },
        convertDuration(
            {
                seconds: 10,
            },
            {
                milliseconds: true,
            },
        ).milliseconds,
    );
    await exited;
    clearTimeout(killTimer);
}

/** Starts `version`'s server and resolves once it serves the app, which is its smoke test. */
async function startServer(version: string): Promise<RunningServer> {
    const port = await findFreePort();
    const serverProcess = spawn(
        process.execPath,
        [
            resolve(
                getVersionDir({
                    versionsDir,
                    version,
                }),
                ReleaseDir.Server,
                'index.js',
            ),
        ],
        {
            /** The IPC channel is how the server asks to switch to a version it installed. */
            stdio: [
                'inherit',
                'inherit',
                'inherit',
                'ipc',
            ],
            env: {
                ...process.env,
                [PortEnvVar.Backend]: String(port),
                [launcherOriginEnvVar]: publicAddress.origin,
            },
        },
    );
    const server: RunningServer = {
        version,
        port,
        process: serverProcess,
    };
    serverProcess.on('message', async (message) => {
        if (checkValidShape(message, launcherSwitchRequestShape)) {
            try {
                await switchTo(message.switchTo);
            } catch (error) {
                log.error(
                    `agent-storm failed to switch to ${message.switchTo}: ${extractErrorMessage(error)}`,
                );
                process.exit(1);
            }
        }
    });
    /** Only the running server exiting on its own ends the launcher; a stopped one was replaced. */
    serverProcess.on('exit', (code) => {
        if (launcherState.server === server) {
            process.exit(code ?? 1);
        }
    });
    try {
        await Promise.race([
            waitUntil.isTrue(
                () => isServingApp(port),
                {
                    interval: {
                        milliseconds: 200,
                    },
                    timeout: {
                        minutes: 1,
                    },
                },
                `agent-storm ${version} never started serving the app.`,
            ),
            once(serverProcess, 'exit').then(() => {
                throw new Error(`agent-storm ${version} exited while starting.`);
            }),
        ]);
    } catch (error) {
        await stopServer(server);
        throw error;
    }
    return server;
}

/**
 * Replaces the running server with `version`'s. When the new version fails to start, it's rejected
 * and the replaced version starts again.
 */
async function switchTo(version: string) {
    const replacedServer = launcherState.server;
    if (launcherState.isSwitching || !replacedServer || replacedServer.version === version) {
        return;
    }
    launcherState.isSwitching = true;
    launcherState.server = undefined;
    try {
        await stopServer(replacedServer);
        try {
            launcherState.server = await startServer(version);
            await activateVersion({
                versionsDir,
                version,
            });
            log.success(`agent-storm switched to ${version}.`);
        } catch (error) {
            log.error(
                `agent-storm ${version} failed to start, so ${replacedServer.version} is running again: ${extractErrorMessage(error)}`,
            );
            const failedServer = launcherState.server;
            launcherState.server = undefined;
            if (failedServer) {
                await stopServer(failedServer);
            }
            await rejectVersion({
                versionsDir,
                version,
            });
            launcherState.server = await startServer(replacedServer.version);
        }
    } finally {
        launcherState.isSwitching = false;
    }
}

/** Undefined while no server is ready to take requests. */
function getTargetPort() {
    return launcherState.isSwitching ? undefined : launcherState.server?.port;
}

const publicServer = publicAddress.tlsOptions
    ? createHttpsServer(publicAddress.tlsOptions)
    : createHttpServer();
publicServer.on('request', (incoming, response) => {
    proxyRequest({
        incoming,
        response,
        targetPort: getTargetPort(),
    });
});
publicServer.on('upgrade', (incoming, socket: Duplex, head: Buffer) => {
    proxyUpgrade({
        incoming,
        socket,
        head,
        targetPort: getTargetPort(),
    });
});
publicServer.listen(publicAddress.port, '0.0.0.0');
await once(publicServer, 'listening');
await writeFileAtomically({
    path: launcherOriginPath,
    contents: publicAddress.origin,
});

(
    [
        'SIGINT',
        'SIGTERM',
    ] satisfies ReadonlyArray<NodeJS.Signals>
).forEach((signal) => {
    process.on(signal, async () => {
        const server = launcherState.server;
        launcherState.server = undefined;
        if (server) {
            await stopServer(server);
        }
        process.exit(0);
    });
});

const activeVersions = await readActiveVersions(versionsDir);
if (!activeVersions) {
    throw new Error(`No agent-storm release is active in ${versionsDir}.`);
}
try {
    launcherState.server = await startServer(activeVersions.active);
} catch (error) {
    if (!activeVersions.previous) {
        throw error;
    }
    log.error(
        `agent-storm ${activeVersions.active} failed to start, so ${activeVersions.previous} is running instead: ${extractErrorMessage(error)}`,
    );
    await rejectVersion({
        versionsDir,
        version: activeVersions.active,
    });
    launcherState.server = await startServer(activeVersions.previous);
}

log.success(`agent-storm ${launcherState.server.version} is running at ${publicAddress.origin}`);
