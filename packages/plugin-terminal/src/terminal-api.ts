import {definePluginApi, terminalPluginId} from '@agent-storm/common';
import {defineShape} from 'object-shape-tester';

/** The Terminal plugin's calls into its server part. */
export const terminalApi = definePluginApi({
    pluginId: terminalPluginId,
    calls: {
        /** Saves a file dropped onto a terminal, so its path can be typed into the terminal. */
        upload: {
            requestShape: defineShape({
                filename: '',
                dataBase64: '',
            }),
            responseShape: defineShape({
                path: '',
            }),
        },
    },
});
