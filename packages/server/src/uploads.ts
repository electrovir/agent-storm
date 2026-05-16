import {randomBytes} from 'node:crypto';
import {mkdir, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {extname, join} from 'node:path';

const uploadsDir = join(tmpdir(), 'agent-storm-uploads');

function safeFilename(input: string): string {
    const trimmed = input.trim() || 'upload';
    /**
     * Strip anything that isn't word/dash/dot/underscore so the resulting filesystem name can't
     * be a directory traversal attempt or contain shell metacharacters that bite us later when
     * the path is dropped into a terminal.
     */
    const sanitized = trimmed.replace(/[^\w.-]/g, '_');
    return sanitized.slice(0, 80);
}

export async function saveUpload({
    filename,
    dataBase64,
}: Readonly<{filename: string; dataBase64: string}>): Promise<string> {
    await mkdir(uploadsDir, {recursive: true});
    const safe = safeFilename(filename);
    const stem = safe.slice(0, safe.length - extname(safe).length) || 'upload';
    const ext = extname(safe);
    const uniqueId = randomBytes(4).toString('hex');
    const filePath = join(uploadsDir, `${Date.now()}-${uniqueId}-${stem}${ext}`);
    const buffer = Buffer.from(dataBase64, 'base64');
    await writeFile(filePath, buffer);
    return filePath;
}
