import {PluginStatus, type PluginEntry, type PluginTurnedOff} from '@agent-storm/common';
import {satisfies, validRange} from 'semver';

export function isValidCoreVersionRange(coreVersionRange: string) {
    /** `validRange` accepts a blank range as `*`, which would let a plugin skip declaring one. */
    return !!coreVersionRange.trim() && validRange(coreVersionRange) != undefined;
}

export function isCoreVersionInRange({
    coreVersion,
    coreVersionRange,
}: Readonly<{coreVersion: string; coreVersionRange: string}>) {
    return satisfies(coreVersion, coreVersionRange);
}

/** The plugins that run now but whose range excludes `coreVersion`. */
export function findPluginsTurnedOffByCore({
    plugins,
    coreVersion,
}: Readonly<{
    plugins: ReadonlyArray<Readonly<PluginEntry>>;
    coreVersion: string;
}>): PluginTurnedOff[] {
    return plugins.flatMap((plugin) => {
        return plugin.status === PluginStatus.Active &&
            plugin.manifest &&
            !isCoreVersionInRange({
                coreVersion,
                coreVersionRange: plugin.manifest.coreVersionRange,
            })
            ? [
                  {
                      pluginId: plugin.id,
                      name: plugin.manifest.name || plugin.folderName,
                      coreVersionRange: plugin.manifest.coreVersionRange,
                  },
              ]
            : [];
    });
}
