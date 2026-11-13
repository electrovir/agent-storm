import {getEnumValues, getObjectTypedKeys} from '@augment-vir/common';
import {
    pluginModulesSymbolName,
    SharedModuleName,
    sharedModulesSymbolName,
} from '../frontend/util/shared-module-names.js';

/** The parts of esbuild's plugin API this plugin uses, so core doesn't depend on esbuild. */
type EsbuildPluginBuild = {
    onResolve(
        options: Readonly<{
            filter: RegExp;
        }>,
        callback: (
            args: Readonly<{
                path: string;
            }>,
        ) => {
            path: string;
            namespace: string;
        },
    ): void;
    onLoad(
        options: Readonly<{
            filter: RegExp;
            namespace: string;
        }>,
        callback: (
            args: Readonly<{
                path: string;
            }>,
        ) => {
            contents: string;
            loader: 'js';
        },
    ): void;
};

const sharedNamespace = 'agent-storm-shared-module';
const dependencyNamespace = 'agent-storm-plugin-dependency';

function escapeRegExp(text: string) {
    return text.replaceAll(/[.*+?^${}()|[\]\\/]/g, String.raw`\$&`);
}

/**
 * An esbuild plugin for a plugin's browser bundle. Each {@link SharedModuleName} import reads the
 * app's own copy of that package at runtime instead of bundling another, and each import of a
 * package in `dependencies` reads that plugin's already loaded module. Every plugin in
 * `dependencies` must also be in the manifest's `dependencies`, so it loads first.
 *
 * @example
 *
 * ```ts
 * await build({
 *     entryPoints: ['src/plugin.ts'],
 *     bundle: true,
 *     format: 'esm',
 *     outfile: 'dist/plugin.js',
 *     plugins: [createPluginEsbuildPlugin()],
 * });
 * ```
 */
export function createPluginEsbuildPlugin({
    dependencies,
}: Readonly<{
    /** The plugin id of each package this plugin imports from another plugin, by package name. */
    dependencies?: Readonly<Record<string, string>> | undefined;
}> = {}) {
    const filter = new RegExp(`^(${getEnumValues(SharedModuleName).map(escapeRegExp).join('|')})$`);
    const dependencyNames = getObjectTypedKeys(dependencies || {});
    return {
        name: 'agent-storm-shared-modules',
        setup(build: EsbuildPluginBuild) {
            if (dependencyNames.length) {
                build.onResolve(
                    {
                        filter: new RegExp(`^(${dependencyNames.map(escapeRegExp).join('|')})$`),
                    },
                    (args) => {
                        return {
                            path: args.path,
                            namespace: dependencyNamespace,
                        };
                    },
                );
                build.onLoad(
                    {
                        filter: /.*/,
                        namespace: dependencyNamespace,
                    },
                    (args) => {
                        return {
                            contents: `module.exports = globalThis[Symbol.for(${JSON.stringify(pluginModulesSymbolName)})][${JSON.stringify(dependencies?.[args.path])}];`,
                            loader: 'js',
                        };
                    },
                );
            }
            build.onResolve(
                {
                    filter,
                },
                (args) => {
                    return {
                        path: args.path,
                        namespace: sharedNamespace,
                    };
                },
            );
            build.onLoad(
                {
                    filter: /.*/,
                    namespace: sharedNamespace,
                },
                (args) => {
                    return {
                        contents: `module.exports = globalThis[Symbol.for(${JSON.stringify(sharedModulesSymbolName)})][${JSON.stringify(args.path)}];`,
                        loader: 'js',
                    };
                },
            );
        },
    };
}
