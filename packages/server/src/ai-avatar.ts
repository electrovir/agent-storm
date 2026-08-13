import {type AiDefinition} from '@agent-storm/common';
import {
    calculateRelativeDate,
    createFullDate,
    getNowInUserTimezone,
    isDateAfter,
    type AnyDuration,
} from 'date-vir';
import {randomBytes} from 'node:crypto';
import {mkdir, readdir, readFile, stat, unlink, writeFile} from 'node:fs/promises';
import {extname, join} from 'node:path';
import {avatarsDir} from './file-paths.js';

/**
 * Image types an avatar may use, mapped to the mime type handed back to the browser. SVG is
 * deliberately absent: it can carry script, and these bytes end up in an `<img>` built from a blob
 * URL in the app's own origin.
 */
const avatarMimeTypes: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
};

/**
 * Ceiling on a stored avatar. The frontend shrinks images before uploading, so anything approaching
 * this is either a client that skipped the resize or a mistake — either way it has no business
 * sitting in the user's config directory.
 */
const maxAvatarBytes = 1024 * 1024;

/**
 * Filenames this module produces, and therefore the only ones it will read back. Matching against
 * the pattern (rather than sanitizing on read) is what keeps a crafted `avatarFile` in the config
 * from reaching outside {@link avatarsDir}.
 */
const avatarFileNamePattern = /^[a-f0-9]{16}\.(?:png|jpe?g|webp|gif)$/;

/**
 * How long an avatar file is protected from pruning regardless of whether any definition references
 * it. Covers the gap between the upload and the config save that names it: without the grace
 * period, an unrelated config write landing in between (a sidebar toggle in another tab, say) would
 * delete the image the user just dropped.
 */
const pruneGracePeriod: AnyDuration = {
    hours: -1,
};

/**
 * Store an avatar image and return the bare filename to record in an AI definition. The original
 * filename is used only for its extension — the stored name is random, so two users' `avatar.png`
 * can't collide and nothing in the name can escape the directory.
 */
export async function saveAiAvatar({
    filename,
    dataBase64,
}: Readonly<{filename: string; dataBase64: string}>): Promise<string> {
    const extension = extname(filename).toLowerCase();
    if (!avatarMimeTypes[extension]) {
        throw new Error(
            `Unsupported avatar file type '${extension || filename}'. Use PNG, JPEG, WebP, or GIF.`,
        );
    }
    const buffer = Buffer.from(dataBase64, 'base64');
    if (!buffer.length) {
        throw new Error('Avatar image was empty.');
    } else if (buffer.length > maxAvatarBytes) {
        throw new Error(`Avatar image is larger than ${maxAvatarBytes} bytes.`);
    }
    await mkdir(avatarsDir, {
        recursive: true,
    });
    const avatarFile = `${randomBytes(8).toString('hex')}${extension}`;
    await writeFile(join(avatarsDir, avatarFile), buffer);
    return avatarFile;
}

export async function readAiAvatar(
    avatarFile: string,
): Promise<{dataBase64: string; mimeType: string}> {
    if (!avatarFileNamePattern.test(avatarFile)) {
        throw new Error(`'${avatarFile}' is not an avatar file name.`);
    }
    const mimeType = avatarMimeTypes[extname(avatarFile).toLowerCase()];
    if (!mimeType) {
        throw new Error(`'${avatarFile}' is not a supported avatar file type.`);
    }
    const buffer = await readFile(join(avatarsDir, avatarFile));
    return {
        dataBase64: buffer.toString('base64'),
        mimeType,
    };
}

/**
 * Delete avatar files no definition points at anymore, which is how replacing or removing an avatar
 * gets cleaned up. Only touches files this module wrote (see {@link avatarFileNamePattern}) and only
 * once they're past {@link pruneGracePeriod}, and swallows every failure — a stuck file is not worth
 * failing a config save over.
 */
export async function pruneAiAvatars(
    aiDefinitions: ReadonlyArray<Readonly<AiDefinition>>,
): Promise<void> {
    const entries = await readdir(avatarsDir).catch(() => undefined);
    if (!entries) {
        return;
    }
    const referenced = aiDefinitions.map((definition) => definition.avatarFile).filter(Boolean);
    const cutoff = calculateRelativeDate(getNowInUserTimezone(), pruneGracePeriod);
    await Promise.all(
        entries.map(async (entry) => {
            if (!avatarFileNamePattern.test(entry) || referenced.includes(entry)) {
                return;
            }
            const filePath = join(avatarsDir, entry);
            const stats = await stat(filePath).catch(() => undefined);
            if (!stats) {
                return;
            }
            const modifiedAt = createFullDate(stats.mtimeMs, cutoff.timezone);
            if (
                isDateAfter({
                    fullDate: cutoff,
                    relativeTo: modifiedAt,
                })
            ) {
                await unlink(filePath).catch(() => {
                    /* best-effort cleanup */
                });
            }
        }),
    );
}
