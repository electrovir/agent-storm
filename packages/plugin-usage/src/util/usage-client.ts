import {createPluginApiClient} from '@agent-storm/core/frontend';
import {usageApi} from '../usage-api.js';

/** Calls the Usage plugin's server part. */
export const usageClient = createPluginApiClient(usageApi);
