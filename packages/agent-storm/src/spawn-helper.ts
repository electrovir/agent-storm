import {chmod, readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {hasErrorCode} from './paths.js';

async function readDirIfExists(dir: string) {
    try {
        return await readdir(dir);
    } catch (error) {
        if (hasErrorCode(error, 'ENOENT')) {
            return [];
        }
        throw error;
    }
}

/**
 * Makes node-pty's `spawn-helper` executable in every prebuild that has one, without a shell glob
 * so it also runs on Windows, whose prebuilds have no `spawn-helper`. Does nothing when node-pty
 * has no prebuilds.
 *
 * @category Util
 */
export async function makeSpawnHelpersExecutable(prebuildsDir: string) {
    await Promise.all(
        (await readDirIfExists(prebuildsDir)).map(async (prebuildDir) => {
            try {
                await chmod(join(prebuildsDir, prebuildDir, 'spawn-helper'), 0o755);
            } catch (error) {
                if (!hasErrorCode(error, 'ENOENT')) {
                    throw error;
                }
            }
        }),
    );
}
