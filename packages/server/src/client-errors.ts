import {appendFile, mkdir, stat, truncate, writeFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const logPath = resolve(repoRoot, '.logs', 'frontend-errors.log');

/** Hard cap so a misbehaving (or malicious) client can't fill the disk. */
const maxLogFileBytes = 10 * 1024 * 1024;

/** Field-level caps so a single record can't dominate the log. */
const maxMessageLength = 4 * 1024;
const maxStackLength = 16 * 1024;
const maxShortFieldLength = 512;

/**
 * Truncate the frontend errors log so each `npm start` begins with a clean slate, matching the
 * behavior of `.logs/dev.log` produced by `scripts/run-with-log.mjs`.
 */
export async function resetClientErrorLog(): Promise<void> {
    await mkdir(dirname(logPath), {recursive: true});
    const banner = `=== frontend errors @ ${new Date().toISOString()} ===\n`;
    await writeFile(logPath, banner, 'utf-8');
}

export type ClientErrorRecord = {
    message: string;
    stack: string | null;
    source: string | null;
    url: string | null;
    userAgent: string | null;
};

/**
 * Strip control characters and ANSI escape sequences so a logged payload can't smuggle in fake
 * header lines, hijack the terminal cursor when the user `cat`s the log, or break the line-based
 * parsing done by `scripts/check-frontend-errors.mjs`. Caps length per field.
 */
function sanitize(value: string | null | undefined, maxLength: number): string | null {
    if (value == undefined || value === '') {
        return null;
    }
    /* eslint-disable-next-line no-control-regex */
    const stripped = value.replace(/[\x00-\x1f\x7f]/g, ' ');
    return stripped.length > maxLength ? stripped.slice(0, maxLength) + '…' : stripped;
}

/**
 * Stack traces legitimately span multiple lines, so we keep newlines but rewrite every other
 * control char and indent continuation lines so they can't be confused with header lines.
 */
function sanitizeStack(value: string | null | undefined): string | null {
    if (value == undefined || value === '') {
        return null;
    }
    /* eslint-disable-next-line no-control-regex */
    const stripped = value.replace(/[\x00-\x09\x0b-\x1f\x7f]/g, ' ');
    const capped = stripped.length > maxStackLength
        ? stripped.slice(0, maxStackLength) + '…'
        : stripped;
    return capped
        .split('\n')
        .map((line) => '  ' + line)
        .join('\n');
}

async function rotateIfTooLarge(): Promise<void> {
    const info = await stat(logPath).catch(() => undefined);
    if (info && info.size > maxLogFileBytes) {
        await truncate(logPath, 0);
        const banner = `=== frontend errors @ ${new Date().toISOString()} (rotated: prior log exceeded ${maxLogFileBytes} bytes) ===\n`;
        await appendFile(logPath, banner, 'utf-8');
    }
}

export async function appendClientError(record: Readonly<ClientErrorRecord>): Promise<void> {
    await rotateIfTooLarge();
    const message = sanitize(record.message, maxMessageLength) ?? '<no message>';
    const source = sanitize(record.source, maxShortFieldLength);
    const url = sanitize(record.url, maxShortFieldLength);
    const userAgent = sanitize(record.userAgent, maxShortFieldLength);
    const stack = sanitizeStack(record.stack);
    const lines = [
        `--- ${new Date().toISOString()} [${source ?? 'unknown'}] ---`,
        `url: ${url ?? '<none>'}`,
        `ua:  ${userAgent ?? '<none>'}`,
        `message: ${message}`,
    ];
    if (stack) {
        lines.push('stack:', stack);
    }
    lines.push('');
    await appendFile(logPath, lines.join('\n') + '\n', 'utf-8');
}
