import {extractErrorMessage, log} from '@augment-vir/common';
import {mkdir, rename} from 'node:fs/promises';
import {basename, join} from 'node:path';
import {runCommand} from './run-command.js';

/**
 * Deleting a checkout file by file (`git worktree remove` or `rm -rf`) takes several seconds for a
 * big `node_modules`, and the folder keeps showing up until it finishes. A rename is instant, so
 * the folder gets moved out of sight first and git only drops its record of the missing folder.
 *
 * Undefined when the move fails, such as across volumes.
 *
 * @category Util
 */
export async function moveAside({
    folder,
    deletingDir,
}: Readonly<{folder: string; deletingDir: string}>) {
    const movedPath = join(deletingDir, `${basename(folder)}-${Date.now()}`);
    return await mkdir(deletingDir, {
        recursive: true,
    })
        .then(async () => await rename(folder, movedPath))
        .then(
            () => movedPath,
            () => undefined,
        );
}

/**
 * `rm -rf` in a separate Node process: an in-process `rm` of a checkout queues thousands of file
 * operations on the server's libuv thread pool, and every other file read or write in the server
 * (each `/folders` poll included) then waits behind them for seconds.
 *
 * @category Util
 */
export async function deleteFolderInChildProcess(path: string) {
    await runCommand(
        process.execPath,
        [
            '-e',
            "require('node:fs').rmSync(process.argv[1], {recursive: true, force: true, maxRetries: 3, retryDelay: 250});",
            path,
        ],
        {
            timeout: {
                minutes: 30,
            },
        },
    );
}

/**
 * Deletes a folder moved by {@link moveAside} in the background, or `folder` in place otherwise.
 *
 * @category Util
 */
export async function deleteMovedFolder({
    folder,
    movedPath,
}: Readonly<{folder: string; movedPath: string | undefined}>) {
    const deletion = deleteFolderInChildProcess(movedPath || folder);
    if (movedPath) {
        void deletion.catch((error: unknown) => {
            log.warning(`Failed to delete ${movedPath}: ${extractErrorMessage(error)}`);
        });
    } else {
        await deletion;
    }
}
