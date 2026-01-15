import * as fs from 'node:fs';
import {Client, type ClientChannel} from 'ssh2';
import type {SshHost} from './ssh-config-parser.js';

/**
 * Represents an SSH connection.
 *
 * @category Internal
 */
export interface SshConnection {
    id: string;
    host: SshHost;
    client: Client;
    shell: ClientChannel | null;
    currentDir: string;
    repoPath: string;
    worktreePath: string | undefined;
    branch: string | undefined;
    isConnected: boolean;
    outputBuffer: string;
}

let connectionIdCounter = 0;

/**
 * Creates a unique connection ID.
 *
 * @category Internal
 */
export function createConnectionId(): string {
    return `conn-${++connectionIdCounter}`;
}

/**
 * Connects to an SSH host.
 *
 * @category Internal
 */
export async function connectSsh(host: SshHost): Promise<Client> {
    return new Promise((resolve, reject) => {
        const client = new Client();

        client.on('ready', () => {
            resolve(client);
        });

        client.on('error', (err) => {
            reject(err);
        });

        const connectConfig: Parameters<Client['connect']>[0] = {
            host: host.hostname,
            port: host.port || 22,
            username: host.user || process.env.USER || 'root',
        };

        if (host.identityFile) {
            connectConfig.privateKey = fs.readFileSync(host.identityFile);
        }

        client.connect(connectConfig);
    });
}

/**
 * Executes a command on the SSH client.
 *
 * @category Internal
 */
export async function execCommand(client: Client, command: string): Promise<string> {
    return new Promise((resolve, reject) => {
        client.exec(command, (err, stream) => {
            if (err) {
                reject(err);
                return;
            }

            let output = '';
            let errorOutput = '';

            stream.on('data', (data: Buffer) => {
                output += data.toString();
            });

            stream.stderr.on('data', (data: Buffer) => {
                errorOutput += data.toString();
            });

            stream.on('close', (code: number) => {
                if (code === 0) {
                    resolve(output);
                } else {
                    reject(new Error(`Command failed with code ${code}: ${errorOutput || output}`));
                }
            });
        });
    });
}

/**
 * Creates an interactive shell on the SSH client.
 *
 * @category Internal
 */
export async function createShell(client: Client): Promise<ClientChannel> {
    return new Promise((resolve, reject) => {
        client.shell({term: 'xterm-256color'}, (err, stream) => {
            if (err) {
                reject(err);
                return;
            }
            resolve(stream);
        });
    });
}

/**
 * Writes data to the shell.
 *
 * @category Internal
 */
export function writeToShell(shell: ClientChannel, data: string): void {
    shell.write(data);
}
