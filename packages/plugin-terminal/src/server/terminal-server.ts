import {definePluginServer} from '@agent-storm/core/server';
import {terminalApi} from '../terminal-api.js';
import {saveUpload} from './uploads.js';

export default definePluginServer({
    api: terminalApi,
    start({tempDir}) {
        return {
            calls: {
                async upload(request) {
                    return {
                        path: await saveUpload({
                            ...request,
                            uploadsDir: tempDir,
                        }),
                    };
                },
            },
        };
    },
});
