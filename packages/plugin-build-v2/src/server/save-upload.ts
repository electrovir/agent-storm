import {convertByteSize, createCuid2, type AnyByteSize} from '@augment-vir/common';
import {mkdir, readFile, stat, writeFile} from 'node:fs/promises';
import {dirname, extname, join, resolve} from 'node:path';

function safeFilename(input: string): string {
    const trimmed = input.trim() || 'upload';
    /**
     * Strip anything that isn't word/dash/dot/underscore so the resulting filesystem name can't be
     * a directory traversal attempt or contain shell metacharacters that bite us later when the
     * path is dropped into a terminal.
     */
    const sanitized = trimmed.replace(/[^\w.-]/g, '_');
    return sanitized.slice(0, 80);
}

/** Writes one dropped file into `uploadsDir` under a unique, sanitized name, and returns its path. */
export async function saveUpload({
    filename,
    dataBase64,
    uploadsDir,
}: Readonly<{filename: string; dataBase64: string; uploadsDir: string}>) {
    await mkdir(uploadsDir, {
        recursive: true,
    });
    const safe = safeFilename(filename);
    const stem = safe.slice(0, safe.length - extname(safe).length) || 'upload';
    const ext = extname(safe);
    const filePath = join(uploadsDir, `${Date.now()}-${createCuid2()}-${stem}${ext}`);
    const buffer = Buffer.from(dataBase64, 'base64');
    await writeFile(filePath, buffer);
    return filePath;
}

/** The content travels base64-encoded inside one JSON response, so it can't be unbounded. */
const maxReadUploadSize = {
    megabytes: 20,
} as const satisfies AnyByteSize;

/** Reads a file `saveUpload` wrote, as base64. Rejects any path outside `uploadsDir`. */
export async function readUpload({path, uploadsDir}: Readonly<{path: string; uploadsDir: string}>) {
    const filePath = resolve(path);
    if (dirname(filePath) !== resolve(uploadsDir)) {
        throw new Error(`Not an uploaded file: '${path}'.`);
    } else if (
        (await stat(filePath)).size >
        convertByteSize(maxReadUploadSize, {
            bytes: true,
        }).bytes
    ) {
        throw new Error(`Uploaded file is too large to preview: '${path}'.`);
    } else {
        return (await readFile(filePath)).toString('base64');
    }
}
