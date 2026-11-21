import {type BuildV2ServerExports} from '@agent-storm/common';
import {type PluginServerHost} from '@agent-storm/core/server';

const reviewServer: {
    host: PluginServerHost | undefined;
    waitForBuildV2: (() => Promise<BuildV2ServerExports | undefined>) | undefined;
} = {
    host: undefined,
    waitForBuildV2: undefined,
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

/** Called by the plugin's `start` before anything runs a review thread. */
export function setReviewBuildV2(
    waitForBuildV2: (() => Promise<BuildV2ServerExports | undefined>) | undefined,
) {
    reviewServer.waitForBuildV2 = waitForBuildV2;
}

/**
 * Build V2's server part, which runs the review's AI work as threads. Waits out a Build V2 restart,
 * and throws while Build V2 isn't running.
 */
export async function readReviewBuildV2() {
    if (!reviewServer.waitForBuildV2) {
        throw new Error('The review plugin read Build V2 before its server part started.');
    }
    const buildV2 = await reviewServer.waitForBuildV2();
    if (!buildV2) {
        throw new Error('Reviews run as Build V2 threads, and Build V2 is not running.');
    }
    return buildV2;
}
