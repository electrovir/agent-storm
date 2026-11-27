import {convertByteSize, type AnyByteSize} from '@augment-vir/common';
import {readFile, stat} from 'node:fs/promises';
import {extname, isAbsolute} from 'node:path';

/**
 * The image files the chat shows, by lowercase extension. SVG is safe here: the chat shows it
 * through an `<img>`, which never runs its scripts.
 */
const imageMimeTypes: Readonly<Record<string, string>> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
};

/** The image travels base64-encoded inside one JSON response, so it can't be unbounded. */
const maxChatImageSize = {
    megabytes: 20,
} as const satisfies AnyByteSize;

/**
 * Checks that `path` is an absolute path to an image file the chat can show, and returns its MIME
 * type. Any image the user's account can read is allowed: the agent that names it already reads any
 * file the user can.
 */
export async function checkChatImage(path: string) {
    const mimeType = imageMimeTypes[extname(path).toLowerCase()];
    if (!isAbsolute(path)) {
        throw new Error(`Image path must be absolute: '${path}'.`);
    } else if (!mimeType) {
        throw new Error(
            `Not a supported image file: '${path}'. Supported: ${Object.keys(imageMimeTypes).join(', ')}.`,
        );
    }
    const stats = await stat(path);
    if (!stats.isFile()) {
        throw new Error(`Not a file: '${path}'.`);
    } else if (
        stats.size >
        convertByteSize(maxChatImageSize, {
            bytes: true,
        }).bytes
    ) {
        throw new Error(`Image is too large to show: '${path}'.`);
    } else {
        return mimeType;
    }
}

/** Reads an image file for the chat to show, as base64 with its MIME type. */
export async function readChatImage(path: string) {
    const mimeType = await checkChatImage(path);
    return {
        mimeType,
        dataBase64: (await readFile(path)).toString('base64'),
    };
}
