/**
 * The file each GitHub release carries its bundled release in, as a gzipped tarball.
 *
 * @category Internal
 */
export const releaseAssetName = 'agent-storm.tgz';

/**
 * The file at the top of a bundled release that holds the version of `@agent-storm/core` it was
 * built with, which plugins' core version ranges are checked against.
 *
 * @category Internal
 */
export const releaseCoreVersionFileName = 'core-version.json';

/**
 * The folders at the top of a bundled release.
 *
 * @category Internal
 */
export enum ReleaseDir {
    /** The server and every script it spawns, each bundled into one `.js` file. */
    Server = 'server',
    /** The built frontend, served by the server. */
    Frontend = 'frontend',
    /** One folder per built-in plugin, each laid out like an external plugin's folder. */
    Plugins = 'plugins',
}
