import {definePluginServer} from '@agent-storm/core/server';
import {viewerApi} from '../viewer-api.js';
import {readViewerFile} from './viewer-file.js';

export default definePluginServer({
    api: viewerApi,
    start() {
        return {
            calls: {
                readFile: readViewerFile,
            },
        };
    },
});
