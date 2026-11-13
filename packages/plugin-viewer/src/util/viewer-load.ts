import {ViewerFileStatus, ViewerFileType} from '@agent-storm/common';
import {createPluginApiClient} from '@agent-storm/core/frontend';
import {viewerApi} from '../viewer-api.js';
import {buildMarkdownDocument, decodeBase64Bytes, decodeBase64Text} from './viewer-document.js';

/** A file the server sent, prepared for the pane to show. */
export type ViewerFile = Readonly<{
    fileType: ViewerFileType;
    resolvedPath: string;
    modifiedAtMs: number;
    /** The HTML document of an HTML or Markdown file. Empty for an image. */
    srcdoc: string;
    /** An object URL of an image file, which the pane revokes. Empty otherwise. */
    imageUrl: string;
}>;

const contentBuilders: Readonly<
    Record<
        ViewerFileType,
        (params: Readonly<{contentBase64: string; mimeType: string}>) => {
            srcdoc: string;
            imageUrl: string;
        }
    >
> = {
    [ViewerFileType.Html]({contentBase64}) {
        return {
            srcdoc: decodeBase64Text(contentBase64),
            imageUrl: '',
        };
    },
    [ViewerFileType.Markdown]({contentBase64}) {
        return {
            srcdoc: buildMarkdownDocument(decodeBase64Text(contentBase64)),
            imageUrl: '',
        };
    },
    [ViewerFileType.Image]({contentBase64, mimeType}) {
        return {
            srcdoc: '',
            imageUrl: URL.createObjectURL(
                new Blob([decodeBase64Bytes(contentBase64)], {
                    type: mimeType,
                }),
            ),
        };
    },
};

/** What the pane says for each status that has no file to show. */
export const viewerStatusMessages: Readonly<Record<ViewerFileStatus, string | undefined>> = {
    [ViewerFileStatus.Loaded]: undefined,
    [ViewerFileStatus.Unchanged]: undefined,
    [ViewerFileStatus.NotFound]: 'No file exists at this path.',
    [ViewerFileStatus.NotAFile]: 'This path is not a file.',
    [ViewerFileStatus.UnsupportedType]: 'Only HTML, Markdown, and image files can be shown.',
    [ViewerFileStatus.TooLarge]: 'This file is too large to show.',
};

/**
 * Asks the server for a file. With `knownModifiedAtMs` set, an unchanged file answers `Unchanged`
 * and sends no content. `file` is only set for `Loaded`.
 */
export async function loadViewerFile({
    folder,
    path,
    knownModifiedAtMs,
}: Readonly<{folder: string; path: string; knownModifiedAtMs: number}>) {
    const response = await createPluginApiClient(viewerApi).call('readFile', {
        folder,
        path,
        knownModifiedAtMs,
    });
    const file: ViewerFile | undefined =
        response.status === ViewerFileStatus.Loaded && response.fileType
            ? {
                  fileType: response.fileType,
                  resolvedPath: response.resolvedPath,
                  modifiedAtMs: response.modifiedAtMs,
                  ...contentBuilders[response.fileType](response),
              }
            : undefined;
    return {
        status: response.status,
        file,
    };
}
