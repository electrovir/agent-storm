import {uploadEndpoint} from '@agent-storm/common';
import {HttpMethod} from '@rest-vir/api';
import {convertDuration} from 'date-vir';
import {fetchApi} from '../../util/api-client.js';

function fileToBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.addEventListener('load', () => {
            const result = reader.result;
            if (typeof result !== 'string') {
                reject(new Error('FileReader produced non-string result.'));
                return;
            }
            // result is a data URL of the form `data:<mime>;base64,<payload>`.
            const comma = result.indexOf(',');
            resolve(comma >= 0 ? result.slice(comma + 1) : '');
        });
        reader.addEventListener('error', () => {
            return reject(reader.error ?? new Error('FileReader failed.'));
        });
        reader.readAsDataURL(file);
    });
}

export async function uploadDroppedFiles(files: ReadonlyArray<File>): Promise<string[]> {
    return await Promise.all(
        files.map(async (file) => {
            const dataBase64 = await fileToBase64(file);
            return (
                await fetchApi(uploadEndpoint, HttpMethod.Post, {
                    requestData: {
                        filename: file.name || 'upload',
                        dataBase64,
                    },
                })
            ).path;
        }),
    );
}

/**
 * Browsers don't agree on whether dragged files land in `dataTransfer.files` or
 * `dataTransfer.items`. The macOS screenshot-thumbnail drag in particular tends to surface the file
 * only through `items` (kind === 'file'). Collect from both, dedupe by reference.
 */
export function collectDroppedFiles(transfer: DataTransfer): File[] {
    const seen = new Set<File>();
    Array.from(transfer.files).forEach((file) => seen.add(file));
    Array.from(transfer.items).forEach((item) => {
        if (item.kind === 'file') {
            const file = item.getAsFile();
            if (file) {
                seen.add(file);
            }
        }
    });
    return Array.from(seen);
}

type UploadErrorState = {
    uploadError: string | undefined;
    uploadErrorTimeout: ReturnType<typeof setTimeout> | undefined;
};

type UploadErrorUpdate = (newState: Partial<UploadErrorState>) => void;

export function reportDropError(
    updateState: UploadErrorUpdate,
    state: Readonly<UploadErrorState>,
    message: string,
): void {
    if (state.uploadErrorTimeout) {
        clearTimeout(state.uploadErrorTimeout);
    }
    const uploadErrorTimeout = setTimeout(
        () => {
            updateState({
                uploadError: undefined,
                uploadErrorTimeout: undefined,
            });
        },
        convertDuration(
            {
                seconds: 5,
            },
            {
                milliseconds: true,
            },
        ).milliseconds,
    );
    updateState({
        uploadError: message,
        uploadErrorTimeout,
    });
}

function decodeFileUri(uri: string): string {
    const withoutScheme = uri.replace(/^file:\/\/(localhost)?/, '');
    return decodeURIComponent(withoutScheme);
}

/** POSIX-quote a string so a shell receives it verbatim, spaces and all. */
export function shellQuote(input: string): string {
    if (/^[\w@%+=:,./-]+$/.test(input)) {
        return input;
    }
    const escaped = input.replace(/'/g, String.raw`'\''`);
    return `'${escaped}'`;
}

export function extractDroppedPaths(transfer: DataTransfer): string[] {
    const uriList = transfer.getData('text/uri-list');
    if (uriList) {
        return uriList
            .split(/\r?\n/)
            .filter((line) => line && !line.startsWith('#'))
            .map((line) => (line.startsWith('file:') ? decodeFileUri(line) : line));
    }
    const plain = transfer.getData('text/plain');
    if (plain) {
        return plain.split(/\r?\n/).filter((line) => line);
    }
    return [];
}
