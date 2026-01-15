import {spawn} from 'node:child_process';

/**
 * Opens a remote path in VS Code.
 *
 * @category Internal
 */
export function openInVsCode(hostName: string, remotePath: string): void {
    const remoteUri = `vscode-remote://ssh-remote+${hostName}${remotePath}`;

    spawn(
        // eslint-disable-next-line sonarjs/no-os-command-from-path -- Using 'code' from PATH is intentional for VS Code CLI integration
        'code',
        [
            '--folder-uri',
            remoteUri,
        ],
        {
            detached: true,
            stdio: 'ignore',
        },
    ).unref();
}
