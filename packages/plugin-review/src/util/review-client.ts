import {createPluginApiClient} from '@agent-storm/core/frontend';
import {reviewApi} from '../review-api.js';

/** Calls the Review plugin's server part. */
export const reviewClient = createPluginApiClient(reviewApi);
