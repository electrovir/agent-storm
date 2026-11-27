import {type BuildServerExports} from '@agent-storm/common';
import {type PluginServerHost} from '@agent-storm/core/server';

const reviewServer: {
    host: PluginServerHost | undefined;
    waitForBuild: (() => Promise<BuildServerExports | undefined>) | undefined;
} = {
    host: undefined,
    waitForBuild: undefined,
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
export function setReviewBuild(
    waitForBuild: (() => Promise<BuildServerExports | undefined>) | undefined,
) {
    reviewServer.waitForBuild = waitForBuild;
}

/**
 * Build's server part, which runs the review's AI work as threads. Waits out a Build restart, and
 * throws while Build isn't running.
 */
export async function readReviewBuild() {
    if (!reviewServer.waitForBuild) {
        throw new Error('The review plugin read Build before its server part started.');
    }
    const build = await reviewServer.waitForBuild();
    if (!build) {
        throw new Error('Reviews run as Build threads, and Build is not running.');
    }
    return build;
}
