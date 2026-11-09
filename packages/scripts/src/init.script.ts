import {nodePtyPrebuildsDir} from '@agent-storm/server/src/file-paths.js';
import {hasErrorCode} from '@agent-storm/server/src/paths.js';
import {chmod, readdir} from 'node:fs/promises';
import {join} from 'node:path';

/**
 * Makes node-pty's `spawn-helper` executable in every prebuild that has one, without a shell glob
 * so it also runs on Windows, whose prebuilds have no `spawn-helper`.
 */
await Promise.all(
    (await readdir(nodePtyPrebuildsDir)).map(async (prebuildDir) => {
        try {
            await chmod(join(nodePtyPrebuildsDir, prebuildDir, 'spawn-helper'), 0o755);
        } catch (error) {
            if (!hasErrorCode(error, 'ENOENT')) {
                throw error;
            }
        }
    }),
);
