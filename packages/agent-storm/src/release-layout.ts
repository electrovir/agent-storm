/**
 * The file each GitHub release carries its bundled release in, as a gzipped tarball.
 *
 * @category Internal
 */
export const releaseAssetName = 'agent-storm.tgz';

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
}
