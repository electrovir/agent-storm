import {getAiAvatar} from './api-client.js';

/**
 * Object URLs for avatars already fetched, keyed by the definition's `avatarFile`. Avatars are
 * fetched through the API (the backend needs the bearer header, which an `<img src>` can't send),
 * so without this cache every AI-pane tab and every row of the picker would re-request the same
 * bytes on each render.
 *
 * Entries are never evicted: an avatar is a few kilobytes, and a replaced avatar gets a new
 * filename, so the map can only grow by the number of images the user actually picks.
 */
const objectUrlsByFile = new Map<string, string>();

/** In-flight fetches, so a burst of renders for the same avatar shares one request. */
const pendingByFile = new Map<string, Promise<string | undefined>>();

function toObjectUrl({
    dataBase64,
    mimeType,
}: Readonly<{dataBase64: string; mimeType: string}>): string {
    const binary = atob(dataBase64);
    const bytes = Uint8Array.from(binary, (character) => character.codePointAt(0) ?? 0);
    return URL.createObjectURL(
        new Blob([bytes], {
            type: mimeType,
        }),
    );
}

/**
 * Longest edge, in pixels, of a stored avatar. Avatars render at 12-32px, so anything larger is
 * bytes the config directory carries around for nothing. Downscaling here (rather than server-side)
 * also keeps a 12 MP phone photo from being uploaded in the first place.
 */
const maxAvatarPixels = 128;

/**
 * Downscale a dropped or picked image and hand back what the upload endpoint wants. Always
 * re-encodes to PNG so the extension the backend validates matches the bytes, whatever the source
 * format was.
 */
export async function resizeImageForAvatar(
    file: Readonly<Blob>,
): Promise<{filename: string; dataBase64: string}> {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxAvatarPixels / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d');
    if (!context) {
        throw new Error('Could not read the image.');
    }
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/png');
    return {
        filename: 'avatar.png',
        dataBase64: dataUrl.slice(dataUrl.indexOf(',') + 1),
    };
}

/** Cached object URL for an already-loaded avatar, or undefined if it hasn't been fetched yet. */
export function readCachedAvatarUrl(avatarFile: string): string | undefined {
    return objectUrlsByFile.get(avatarFile);
}

/**
 * Fetch an avatar and cache its object URL. Resolves undefined when the file is missing or
 * unreadable, which callers render as "no avatar" — a deleted image shouldn't break a tab strip.
 */
export async function loadAvatarUrl(avatarFile: string): Promise<string | undefined> {
    if (!avatarFile) {
        return undefined;
    }
    const cached = objectUrlsByFile.get(avatarFile);
    if (cached) {
        return cached;
    }
    const pending = pendingByFile.get(avatarFile);
    if (pending) {
        return await pending;
    }
    const request = getAiAvatar(avatarFile)
        .then((avatar) => {
            const objectUrl = toObjectUrl(avatar);
            objectUrlsByFile.set(avatarFile, objectUrl);
            return objectUrl;
        })
        .catch(() => undefined)
        .finally(() => {
            pendingByFile.delete(avatarFile);
        });
    pendingByFile.set(avatarFile, request);
    return await request;
}
