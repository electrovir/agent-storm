import {type PluginServerHost} from '@agent-storm/core/server';

const reviewServer: {
    host: PluginServerHost | undefined;
} = {
    host: undefined,
};

/** Called by the plugin's `start` before anything reads the host. */
export function setReviewHost(host: PluginServerHost | undefined) {
    reviewServer.host = host;
}

/** The app's state and machinery. Throws until the plugin's `start` has run. */
export function readReviewHost() {
    if (!reviewServer.host) {
        throw new Error('The review plugin read the app host before its server part started.');
    }
    return reviewServer.host;
}
