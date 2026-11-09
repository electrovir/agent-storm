import {homedir} from 'node:os';
import {resolve} from 'node:path';
import {normalizePath} from './paths.js';

/**
 * The env vars that keep one running agent-storm apart from another, so a debug copy can run beside
 * the everyday one. With both unset, every path is the default instance's.
 *
 * @category Internal
 */
export enum InstanceEnvVar {
    /**
     * Names the instance. Its name is appended to everything it would otherwise share with the
     * default instance outside {@link userDataDir}: the pty daemon's socket, the logs, uploads, and
     * the server's own state.
     */
    Name = 'AGENT_STORM_INSTANCE',
    /** Overrides {@link userDataDir}. */
    DataDir = 'AGENT_STORM_DATA_DIR',
}

function readInstanceName() {
    const name = process.env[InstanceEnvVar.Name] || '';
    if (name && !/^[a-z0-9-]+$/.test(name)) {
        throw new Error(
            `${InstanceEnvVar.Name} may only hold lowercase letters, digits, and dashes, got "${name}".`,
        );
    }
    return name;
}

/**
 * Empty for the default instance.
 *
 * @category Internal
 */
export const instanceName = readInstanceName();
/**
 * Appended to the names this instance would otherwise share with the default instance.
 *
 * @category Internal
 */
export const instanceSuffix = instanceName ? `-${instanceName}` : '';

/**
 * The default instance's {@link userDataDir}.
 *
 * @category Internal
 */
export const defaultUserDataDir = resolve(homedir(), '.agent-storm');

/**
 * Agent-storm's user-level files: config, its backups, and anything else that outlives a checkout.
 *
 * @category Internal
 */
export const userDataDir = normalizePath(
    process.env[InstanceEnvVar.DataDir] || resolve(homedir(), `.agent-storm${instanceSuffix}`),
);

/**
 * Every installed release, each in a folder named for its version, plus which one is active.
 *
 * @category Internal
 */
export const versionsDir = resolve(userDataDir, 'versions');

/**
 * The output of the launcher that `npx agent-storm` starts in the background.
 *
 * @category Internal
 */
export const launcherLogPath = resolve(userDataDir, 'launcher.log');

/**
 * The origin the running launcher serves the app on, such as `https://localhost:41880`. The
 * launcher writes it once it's listening, since only the launcher reads the TLS settings.
 *
 * @category Internal
 */
export const launcherOriginPath = resolve(userDataDir, 'launcher-origin');

/**
 * A new auth secret, left by a release server for `npx agent-storm` to print and delete, since the
 * server's own output goes to {@link launcherLogPath}.
 *
 * @category Internal
 */
export const pendingAuthSecretPath = resolve(userDataDir, 'pending-auth-secret');
