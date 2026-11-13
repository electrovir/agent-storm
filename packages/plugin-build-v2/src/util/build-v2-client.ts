import {createPluginApiClient} from '@agent-storm/core/frontend';
import {buildV2Api} from '../build-v2-api.js';

/** Calls the Build V2 plugin's server part. */
export const buildV2Client = createPluginApiClient(buildV2Api);
