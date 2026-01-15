import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Represents an SSH host configuration.
 *
 * @category Internal
 */
export interface SshHost {
    name: string;
    hostname: string;
    user?: string;
    port?: number;
    identityFile?: string;
}

/**
 * Parses the SSH config file.
 *
 * @category Internal
 */
export function parseSshConfig(): SshHost[] {
    const configPath = path.join(os.homedir(), '.ssh', 'config');
    if (!fs.existsSync(configPath)) {
        return [];
    }

    const content = fs.readFileSync(configPath, 'utf-8');
    const hosts: SshHost[] = [];
    let currentHost: Partial<SshHost> | null = null;

    for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) {
            continue;
        }

        // Simple split on first whitespace
        const spaceIndex = trimmed.search(/\s/);
        if (spaceIndex === -1) {
            continue;
        }

        const key = trimmed.slice(0, spaceIndex);
        const value = trimmed.slice(spaceIndex + 1).trim();
        if (!key || !value) {
            continue;
        }

        const lowerKey = key.toLowerCase();

        if (lowerKey === 'host') {
            if (currentHost?.name && currentHost.hostname) {
                hosts.push(currentHost as SshHost);
            }
            currentHost = {name: value};
        } else if (currentHost) {
            switch (lowerKey) {
                case 'hostname':
                    currentHost.hostname = value;
                    break;
                case 'user':
                    currentHost.user = value;
                    break;
                case 'port':
                    currentHost.port = parseInt(value, 10);
                    break;
                case 'identityfile':
                    currentHost.identityFile = value.replace('~', os.homedir());
                    break;
            }
        }
    }

    if (currentHost?.name && currentHost.hostname) {
        hosts.push(currentHost as SshHost);
    }

    return hosts;
}

/**
 * Gets SSH hosts that have identity files configured.
 *
 * @category Internal
 */
export function getHostsWithKeys(): SshHost[] {
    const hosts = parseSshConfig();
    return hosts.filter((host) => {
        if (!host.identityFile) {
            return false;
        }
        // Check if the identity file exists
        try {
            fs.accessSync(host.identityFile, fs.constants.R_OK);
            return true;
        } catch {
            return false;
        }
    });
}
