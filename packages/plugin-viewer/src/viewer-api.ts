import {definePluginApi, ViewerFileStatus, ViewerFileType, viewerPaneId} from '@agent-storm/common';
import {defineShape, enumShape, nullableShape} from 'object-shape-tester';

const viewerFileRequestShape = defineShape({
    /** The tab's folder, which a relative `path` resolves against. */
    folder: '',
    /** Relative to `folder`, absolute, or starting with `~/`. */
    path: '',
    /** The `modifiedAtMs` the caller already shows. 0 asks for the content regardless. */
    knownModifiedAtMs: 0,
});

const viewerFileResponseShape = defineShape({
    status: enumShape(ViewerFileStatus),
    resolvedPath: '',
    fileType: nullableShape(enumShape(ViewerFileType)),
    mimeType: '',
    /** The file's modified time in whole milliseconds. 0 when the file can't be read. */
    modifiedAtMs: 0,
    /** The file's bytes, base64-encoded. Empty unless `status` is `Loaded`. */
    contentBase64: '',
});

/** The Viewer plugin's calls into its server part. */
export const viewerApi = definePluginApi({
    pluginId: viewerPaneId,
    calls: {
        readFile: {
            requestShape: viewerFileRequestShape,
            responseShape: viewerFileResponseShape,
        },
    },
});
