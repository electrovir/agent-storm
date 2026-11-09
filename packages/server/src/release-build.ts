import {defineShape} from 'object-shape-tester';

/** What `packages/scripts/src/build-release.script.ts` bakes into a bundled release. */
export type ReleaseBuild = {
    /** The release's git tag, from `git describe --tags`. */
    version: string;
    /** The full git commit hash the release was built from. */
    commit: string;
};

/** The global that `build-release.script.ts` defines as the release's {@link ReleaseBuild}. */
export const releaseBuildGlobalName = 'agentStormReleaseBuild';

declare const agentStormReleaseBuild: ReleaseBuild;

/** `undefined` when running from a git checkout's sources rather than a bundled release. */
export const releaseBuild: ReleaseBuild | undefined =
    typeof agentStormReleaseBuild === 'undefined' ? undefined : agentStormReleaseBuild;

/**
 * Set by the launcher on the release server it starts, to the origin the launcher serves the app
 * on. The server then listens only on loopback, without TLS, since the launcher owns the public
 * port.
 */
export const launcherOriginEnvVar = 'AGENT_STORM_LAUNCHER_ORIGIN';

/** What a release server sends its launcher, over their IPC channel, to switch to another version. */
export const launcherSwitchRequestShape = defineShape({
    /** An installed version. */
    switchTo: '',
});
