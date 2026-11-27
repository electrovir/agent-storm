import {ViewerFileStatus, ViewerFileType} from '@agent-storm/common';
import {convertByteSize, type AnyByteSize} from '@augment-vir/common';
import {hasErrorCode, normalizePath} from 'agent-storm-util';
import {readFile, stat} from 'node:fs/promises';
import {extname, isAbsolute, join} from 'node:path';

/**
 * The only files the Viewer reads, by lowercase extension. SVG is an image here: the browser shows
 * it through an `<img>`, which never runs its scripts.
 */
const viewerFileKinds: Readonly<
    Partial<
        Record<
            string,
            Readonly<{
                fileType: ViewerFileType;
                mimeType: string;
            }>
        >
    >
> = {
    '.html': {
        fileType: ViewerFileType.Html,
        mimeType: 'text/html',
    },
    '.htm': {
        fileType: ViewerFileType.Html,
        mimeType: 'text/html',
    },
    '.md': {
        fileType: ViewerFileType.Markdown,
        mimeType: 'text/markdown',
    },
    '.markdown': {
        fileType: ViewerFileType.Markdown,
        mimeType: 'text/markdown',
    },
    '.png': {
        fileType: ViewerFileType.Image,
        mimeType: 'image/png',
    },
    '.jpg': {
        fileType: ViewerFileType.Image,
        mimeType: 'image/jpeg',
    },
    '.jpeg': {
        fileType: ViewerFileType.Image,
        mimeType: 'image/jpeg',
    },
    '.gif': {
        fileType: ViewerFileType.Image,
        mimeType: 'image/gif',
    },
    '.webp': {
        fileType: ViewerFileType.Image,
        mimeType: 'image/webp',
    },
    '.svg': {
        fileType: ViewerFileType.Image,
        mimeType: 'image/svg+xml',
    },
};

/** The content travels base64-encoded inside one JSON response, so it can't be unbounded. */
const maxViewerFileSize: AnyByteSize = {
    megabytes: 10,
};

/**
 * Where a Viewer tab's path points. A relative path is relative to the tab's folder, because that
 * is where an AI working in the folder writes its files. Absolute paths and `~/` are accepted
 * as-is: the user already reads any file their account can through a terminal tab.
 */
export function resolveViewerPath({folder, path}: Readonly<{folder: string; path: string}>) {
    const trimmedPath = path.trim();
    return normalizePath(
        isAbsolute(trimmedPath) || trimmedPath === '~' || trimmedPath.startsWith('~/')
            ? trimmedPath
            : join(normalizePath(folder), trimmedPath),
    );
}

/** Reads one file for the Viewer, or says why it can't be shown. */
export async function readViewerFile({
    folder,
    path,
    knownModifiedAtMs,
}: Readonly<{folder: string; path: string; knownModifiedAtMs: number}>) {
    const resolvedPath = resolveViewerPath({
        folder,
        path,
    });
    const empty = {
        resolvedPath,
        fileType: undefined,
        mimeType: '',
        modifiedAtMs: 0,
        contentBase64: '',
    };

    const stats = await stat(resolvedPath).catch((error: unknown) => {
        if (hasErrorCode(error, 'ENOENT') || hasErrorCode(error, 'ENOTDIR')) {
            return undefined;
        }
        throw error;
    });
    if (!stats) {
        return {
            ...empty,
            status: ViewerFileStatus.NotFound,
        };
    } else if (!stats.isFile()) {
        return {
            ...empty,
            status: ViewerFileStatus.NotAFile,
        };
    }

    const kind = viewerFileKinds[extname(resolvedPath).toLowerCase()];
    if (!kind) {
        return {
            ...empty,
            status: ViewerFileStatus.UnsupportedType,
        };
    }

    const maxBytes = convertByteSize(maxViewerFileSize, {
        bytes: true,
    }).bytes;
    if (stats.size > maxBytes) {
        return {
            ...empty,
            status: ViewerFileStatus.TooLarge,
        };
    }

    const modifiedAtMs = Math.floor(stats.mtimeMs);
    const found = {
        ...empty,
        ...kind,
        modifiedAtMs,
    };
    if (knownModifiedAtMs && knownModifiedAtMs === modifiedAtMs) {
        return {
            ...found,
            status: ViewerFileStatus.Unchanged,
        };
    }

    const content = await readFile(resolvedPath);
    /** The file can grow between the `stat` and the read. */
    if (content.length > maxBytes) {
        return {
            ...empty,
            status: ViewerFileStatus.TooLarge,
        };
    }
    return {
        ...found,
        status: ViewerFileStatus.Loaded,
        contentBase64: content.toString('base64'),
    };
}
