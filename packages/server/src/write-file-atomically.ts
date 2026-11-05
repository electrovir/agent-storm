import {createCuid2} from '@augment-vir/common';
import {mkdir, rename, rm, writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';

/**
 * Same as `writeFileAndDir` from `@augment-vir/node`, but the contents are staged in a sibling temp
 * file and renamed over `path`. `rename` is atomic within one filesystem, so a concurrent reader or
 * a crash mid-write sees either the previous file or the new one, never a truncated one.
 */
export async function writeFileAtomically({
    path,
    contents,
    mode,
}: Readonly<{
    path: string;
    contents: string;
    /** Permission bits for a newly created file, as `writeFile`'s `mode`. */
    mode?: number | undefined;
}>) {
    await mkdir(dirname(path), {
        recursive: true,
    });
    const tempPath = `${path}.tmp.${createCuid2()}`;
    try {
        await writeFile(tempPath, contents, {
            mode,
        });
        await rename(tempPath, path);
    } catch (error) {
        await rm(tempPath, {
            force: true,
        });
        throw error;
    }
}
