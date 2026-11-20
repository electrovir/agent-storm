import {extractExtension} from '@augment-vir/common';

/** The file name a long paste is uploaded under. */
export const pastedTextFilename = 'pasted-text.txt';

/** The pixel width and height of an attachment card's image thumbnail. */
export const attachmentThumbnailSize = 224;

/** How many characters of a text attachment its card shows. */
export const attachmentPreviewLength = 1000;

/** An attachment card's short label: "Pasted" for a long paste, else the file's extension. */
export function toAttachmentTag(name: string) {
    return name === pastedTextFilename
        ? 'Pasted'
        : extractExtension(name).extension.slice(1).toUpperCase();
}

const imageExtensions: ReadonlyArray<string> = [
    '.png',
    '.jpg',
    '.jpeg',
    '.gif',
    '.webp',
];

/**
 * An absolute path to a file named the way `saveUpload` names uploads: a timestamp, a cuid, then
 * the sanitized original name.
 */
const uploadPathRegExp = /^\/(?:.*\/)?\d+-[a-z][a-z\d]{23}-([^/]+)$/;

/** A file the composer attached to a sent message. */
export type MessageAttachment = {
    path: string;
    /** The sanitized name the file was uploaded under. */
    name: string;
    /** Short label for a card, such as the file's extension. */
    tag: string;
    isImage: boolean;
    isPastedText: boolean;
};

/** Reads an upload's name and kind back out of its path. */
export function toMessageAttachment(path: string): MessageAttachment {
    const name = path.replace(uploadPathRegExp, '$1');
    return {
        path,
        name,
        tag: toAttachmentTag(name),
        isImage: imageExtensions.includes(extractExtension(name).extension.toLowerCase()),
        isPastedText: name === pastedTextFilename,
    };
}

/** Splits off the upload paths the composer appends to a message, one per line, after its text. */
export function splitMessageAttachments(message: string) {
    const lines = message.split('\n');
    const firstAttachmentIndex = lines.findLastIndex((line) => !uploadPathRegExp.test(line)) + 1;

    return {
        text: lines.slice(0, firstAttachmentIndex).join('\n'),
        attachments: lines.slice(firstAttachmentIndex).map((path) => toMessageAttachment(path)),
    };
}
