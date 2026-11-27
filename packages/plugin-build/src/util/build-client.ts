import {createPluginApiClient} from '@agent-storm/core/frontend';
import {buildApi} from '../build-api.js';

/** Calls the Build plugin's server part. */
export const buildClient = createPluginApiClient(buildApi);
