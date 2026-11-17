import {createCuid2} from '@augment-vir/common';
import {mkdir, writeFile} from 'node:fs/promises';
import {extname, join} from 'node:path';

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
