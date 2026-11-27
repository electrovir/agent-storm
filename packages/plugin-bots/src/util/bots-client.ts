import {createPluginApiClient} from '@agent-storm/core/frontend';
import {botsApi} from '../bots-api.js';

/** Calls the Bots plugin's server part. */
export const botsClient = createPluginApiClient(botsApi);
