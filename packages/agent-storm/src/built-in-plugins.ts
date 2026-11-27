import type {ReleaseDir} from './release-layout.js';

/**
 * The plugins that ship with the app, in the order their activities and panes list in. The first
 * enabled activity is where an unrecognized URL goes. Each one's folder is named for its id: inside
 * a release's {@link ReleaseDir.Plugins} folder, or built from `packages/plugin-<id>` in a
 * checkout.
 *
 * @category Internal
 */
export const builtInPlugins: ReadonlyArray<
    Readonly<{
        id: string;
        /** Runs until the user turns it off. Otherwise it waits until the user turns it on. */
        isEnabledByDefault: boolean;
    }>
> = [
    {
        id: 'dashboard',
        isEnabledByDefault: true,
    },
    {
        id: 'build',
        isEnabledByDefault: true,
    },
    {
        id: 'terminal',
        isEnabledByDefault: true,
    },
    {
        id: 'diff',
        isEnabledByDefault: true,
    },
    {
        id: 'review',
        isEnabledByDefault: true,
    },
    {
        id: 'usage',
        isEnabledByDefault: true,
    },
    {
        id: 'bots',
        isEnabledByDefault: true,
    },
    {
        id: 'debug',
        isEnabledByDefault: true,
    },
];

/**
 * The folder inside a built-in plugin's package that its manifest and bundles are built into, laid
 * out exactly as the plugin's release folder is.
 *
 * @category Internal
 */
export const builtInPluginBuildDirName = 'dist-plugin';
