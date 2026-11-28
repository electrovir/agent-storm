// cspell:words unbuilt
import {pluginManifestFileName, pluginManifestShape} from '@agent-storm/common';
import {createPluginEsbuildPlugin} from '@agent-storm/core/build';
import {monorepoRoot} from '@agent-storm/server/src/file-paths.js';
import {typedObjectFromEntries} from '@augment-vir/common';
import {runShellCommand} from '@augment-vir/node';
import {builtInPlugins} from 'agent-storm';
import {sqliteWorkerFileName} from 'agent-storm-util';
import {
    build as buildWithEsbuild,
    stop as stopEsbuild,
    type BuildOptions,
    type Plugin,
} from 'esbuild';
import {watch} from 'node:fs';
import {copyFile, cp, mkdir, readdir, readFile, rm, stat} from 'node:fs/promises';
import {resolve, sep} from 'node:path';
import {assertValidShape} from 'object-shape-tester';

/**
 * The folder, beside a server part's sources and its bundle, that holds a Claude Code plugin: a
 * `.claude-plugin/plugin.json` and its `skills`.
 */
const claudePluginFolderName = 'claude-plugin';

function findPluginPackageDir(pluginId: string) {
    return resolve(monorepoRoot, 'packages', `plugin-${pluginId}`);
}

/**
 * Generates the Prisma client of a plugin package with a `prisma/schema.prisma`, which its server
 * part imports. The generated client isn't committed.
 */
async function generatePrismaClient(packageDir: string) {
    if (await stat(resolve(packageDir, 'prisma', 'schema.prisma')).catch(() => undefined)) {
        await runShellCommand('npx prisma generate --config configs/prisma.config.ts', {
            cwd: packageDir,
            rejectOnError: true,
        });
    }
}

/** Generates the Prisma client of every built-in plugin that has a Prisma schema. */
export async function generateBuiltInPluginPrismaClients() {
    await Promise.all(
        builtInPlugins.map(async (plugin) => {
            await generatePrismaClient(findPluginPackageDir(plugin.id));
        }),
    );
}

/**
 * Copies the plugin's manifest into its build folder before each browser build, so a pane or
 * activity added to the manifest reaches the running app with the bundle that renders it.
 */
function createManifestCopyPlugin({
    manifestPath,
    outDir,
}: Readonly<{
    manifestPath: string;
    outDir: string;
}>): Plugin {
    return {
        name: 'agent-storm-plugin-manifest',
        setup(build) {
            build.onStart(async () => {
                const manifest: unknown = JSON.parse(await readFile(manifestPath, 'utf8'));
                assertValidShape(manifest, pluginManifestShape);
                await copyFile(manifestPath, resolve(outDir, pluginManifestFileName));
            });
        },
    };
}

/**
 * Keeps a server part's database files current before each server build: regenerates the Prisma
 * client when the schema changed, and copies the migrations beside the bundle, where the plugin
 * applies them when it opens its database.
 */
function createDatabaseSyncPlugin({
    packageDir,
    schemaPath,
    migrationsDir,
    outDir,
}: Readonly<{
    packageDir: string;
    schemaPath: string;
    migrationsDir: string;
    outDir: string;
}>): Plugin {
    const state: {
        generatedSchema: string | undefined;
    } = {
        generatedSchema: undefined,
    };
    return {
        name: 'agent-storm-plugin-database',
        setup(build) {
            build.onStart(async () => {
                const schema = await readFile(schemaPath, 'utf8').catch(() => undefined);
                if (schema != undefined && schema !== state.generatedSchema) {
                    await generatePrismaClient(packageDir);
                    state.generatedSchema = schema;
                }
                if (await stat(migrationsDir).catch(() => undefined)) {
                    await cp(migrationsDir, resolve(outDir, 'migrations'), {
                        recursive: true,
                    });
                }
            });
        },
    };
}

/**
 * Patches one line of `@codemirror/view`. Safari 27.2's JIT can compute a block widget's length on
 * that line as `undefined`, after which CodeMirror's tile update loops forever and the Diff pane
 * freezes. Staging a file while scrolled deep inside it triggers this. Moving the length into a
 * local variable avoids the JIT bug. The build fails when CodeMirror changes that line, so an
 * upgrade gets the freeze re-checked.
 */
function createCodemirrorSafariJitPlugin(): Plugin {
    const jitBugLine =
        'let tile = this.cache.findWidget(widget, to - from, flags) || WidgetTile.of(widget, this.view, to - from, flags);';
    return {
        name: 'agent-storm-codemirror-safari-jit',
        setup(build) {
            build.onLoad(
                {
                    filter: /[\\/]@codemirror[\\/]view[\\/]dist[\\/]index\.js$/,
                },
                async ({path}) => {
                    const source = await readFile(path, 'utf8');
                    if (!source.includes(jitBugLine)) {
                        throw new Error(
                            `@codemirror/view no longer contains the line patched by ${createCodemirrorSafariJitPlugin.name}. Check whether staging a file while scrolled deep inside it still freezes the Diff pane in Safari without the patch: remove the patch if not, otherwise update the patched line.`,
                        );
                    }
                    return {
                        contents: source.replace(
                            jitBugLine,
                            'const widgetLength = to - from; let tile = this.cache.findWidget(widget, widgetLength, flags) || WidgetTile.of(widget, this.view, widgetLength, flags);',
                        ),
                        loader: 'js',
                    };
                },
            );
        },
    };
}

type BuiltInPluginBuild = {
    packageDir: string;
    /** Files and folders a build reads that esbuild's metafile doesn't list as inputs. */
    extraWatchPaths: string[];
    options: BuildOptions;
};

async function createBuiltInPluginBuilds({
    pluginId,
    outDir,
    isWatching,
}: Readonly<{
    pluginId: string;
    outDir: string;
    isWatching: boolean;
}>): Promise<BuiltInPluginBuild[]> {
    const packageDir = findPluginPackageDir(pluginId);
    const manifestPath = resolve(packageDir, pluginManifestFileName);
    const manifest: unknown = JSON.parse(await readFile(manifestPath, 'utf8'));
    assertValidShape(manifest, pluginManifestShape);
    await mkdir(outDir, {
        recursive: true,
    });
    /** A server part reads its Markdown files from beside its bundle. */
    const serverDir = resolve(packageDir, 'src', 'server');
    const serverFileNames = await readdir(serverDir).catch(() => undefined);
    const markdownFileNames = (serverFileNames || []).filter((fileName) => {
        return fileName.endsWith('.md');
    });
    await Promise.all(
        markdownFileNames.map(async (fileName) => {
            await copyFile(resolve(serverDir, fileName), resolve(outDir, fileName));
        }),
    );
    /** A Claude Code plugin the server part loads into its AI sessions, such as for skills. */
    const claudePluginDir = resolve(serverDir, claudePluginFolderName);
    const hasClaudePlugin = !!(await stat(claudePluginDir).catch(() => undefined));
    if (hasClaudePlugin) {
        /** Removed first so a deleted skill doesn't outlive a restart. */
        await rm(resolve(outDir, claudePluginFolderName), {
            recursive: true,
            force: true,
        });
        await cp(claudePluginDir, resolve(outDir, claudePluginFolderName), {
            recursive: true,
        });
    }
    /**
     * No bundle imports these, so a rebuild never copies them again. Watch mode's AI passes read
     * their instructions from the copy, so an edit must reach it without an app restart.
     */
    if (isWatching && serverFileNames) {
        watch(
            serverDir,
            {
                recursive: true,
            },
            async (event, fileName) => {
                try {
                    if (fileName?.startsWith(claudePluginFolderName + sep)) {
                        await cp(claudePluginDir, resolve(outDir, claudePluginFolderName), {
                            recursive: true,
                        });
                    } else if (fileName?.endsWith('.md') && !fileName.includes(sep)) {
                        await copyFile(resolve(serverDir, fileName), resolve(outDir, fileName));
                    }
                } catch {
                    /** A deleted or mid-save file is copied again on its next change event. */
                }
            },
        );
    }
    const browserEntryPath = resolve(packageDir, 'src', 'index.ts');
    const serverEntryPath = resolve(packageDir, 'src', 'server', `${pluginId}-server.ts`);
    const schemaPath = resolve(packageDir, 'prisma', 'schema.prisma');
    const migrationsDir = resolve(packageDir, 'prisma', 'migrations');
    const shared: BuildOptions = {
        bundle: true,
        format: 'esm',
        logLevel: 'warning',
        absWorkingDir: packageDir,
        /** Each plugin bundles its own copy of its dependencies, so a release minifies them. */
        minify: !isWatching,
    };
    const hasDatabase = !!(await stat(schemaPath).catch(() => undefined));
    const serverOptions: BuildOptions = {
        ...shared,
        platform: 'node',
        target: 'node22',
        external: [
            /**
             * Native modules, and the Claude Agent SDK, which runs Claude Code from a
             * platform-specific package it finds next to its own.
             */
            'node-pty',
            'better-sqlite3',
            '@anthropic-ai/claude-agent-sdk',
        ],
        banner: {
            /**
             * Bundled CommonJS dependencies `require` Node's built-ins, which ES modules lack. The
             * import is renamed because bundled dependencies declare their own top-level
             * `createRequire`.
             */
            js: "import {createRequire as createBannerRequire} from 'node:module'; const require = createBannerRequire(import.meta.url);",
        },
    };
    return [
        {
            packageDir,
            /** The manifest isn't imported by any source file. */
            extraWatchPaths: [
                manifestPath,
            ],
            options: {
                ...shared,
                platform: 'browser',
                target: 'es2022',
                entryPoints: [
                    browserEntryPath,
                ],
                outfile: resolve(outDir, manifest.browserEntry),
                /** Dependencies import Node's built-ins only behind checks that they run in Node. */
                external: [
                    'node:*',
                ],
                plugins: [
                    createManifestCopyPlugin({
                        manifestPath,
                        outDir,
                    }),
                    createCodemirrorSafariJitPlugin(),
                    createPluginEsbuildPlugin({
                        dependencies: typedObjectFromEntries(
                            (manifest.dependencies || []).map((dependencyId) => {
                                return [
                                    `@agent-storm/plugin-${dependencyId}`,
                                    dependencyId,
                                ] as const;
                            }),
                        ),
                    }),
                ],
            },
        },
        ...(manifest.serverEntry
            ? [
                  {
                      packageDir,
                      /** No source file imports the schema or the migrations. */
                      extraWatchPaths: [
                          schemaPath,
                          migrationsDir,
                      ],
                      options: {
                          ...serverOptions,
                          entryPoints: [
                              serverEntryPath,
                          ],
                          outfile: resolve(outDir, manifest.serverEntry),
                          plugins: [
                              createDatabaseSyncPlugin({
                                  packageDir,
                                  schemaPath,
                                  migrationsDir,
                                  outDir,
                              }),
                          ],
                      },
                  } satisfies BuiltInPluginBuild,
                  /** The server part's database runs its queries in this worker. */
                  ...(hasDatabase
                      ? [
                            {
                                packageDir,
                                extraWatchPaths: [],
                                options: {
                                    ...serverOptions,
                                    entryPoints: [
                                        resolve(
                                            monorepoRoot,
                                            'packages',
                                            'agent-storm-util',
                                            'src',
                                            'sqlite-worker.ts',
                                        ),
                                    ],
                                    outfile: resolve(outDir, sqliteWorkerFileName),
                                },
                            } satisfies BuiltInPluginBuild,
                        ]
                      : []),
              ]
            : []),
    ];
}

function isInsidePath({path, parentPath}: Readonly<{path: string; parentPath: string}>) {
    return path === parentPath || path.startsWith(parentPath + sep);
}

/**
 * Rebuilds a bundle when a file it read changes, using one native recursive watcher for every
 * bundle. Esbuild's own watch mode isn't used because each of its contexts holds a full in-memory
 * cache and polls every input file, which with every built-in plugin watching takes gigabytes of
 * memory and constant CPU. A one-shot build of a bundle is fast enough to not need that cache.
 */
function watchBuiltInPluginBuilds(
    builds: ReadonlyArray<
        Readonly<{
            build: BuiltInPluginBuild;
            run: () => Promise<void>;
            inputs: ReadonlySet<string>;
            isFailed: boolean;
        }>
    >,
) {
    watch(
        monorepoRoot,
        {
            recursive: true,
        },
        (event, fileName) => {
            if (!fileName) {
                return;
            }
            const changedPath = resolve(monorepoRoot, fileName);
            builds
                .filter((entry) => {
                    return (
                        entry.inputs.has(changedPath) ||
                        [
                            ...entry.build.extraWatchPaths,
                            /** A failed build may not have read the file that fixes it yet. */
                            ...(entry.isFailed
                                ? [
                                      resolve(entry.build.packageDir, 'src'),
                                  ]
                                : []),
                        ].some((parentPath) => {
                            return isInsidePath({
                                path: changedPath,
                                parentPath,
                            });
                        })
                    );
                })
                .forEach((entry) => void entry.run());
        },
    );
}

/**
 * Builds every built-in plugin from its `packages/plugin-<id>` package into the folder `findOutDir`
 * gives for its id, laid out as a plugin folder: its manifest, its browser bundle, and its server
 * bundle with its Markdown files and Claude Code plugin when it has a server part. With
 * `isWatching`, rebuilds each bundle whenever its sources change, until the process exits. A failed
 * build is logged and leaves that plugin unbuilt, so the app still starts.
 */
export async function buildBuiltInPlugins({
    findOutDir,
    isWatching,
}: Readonly<{
    findOutDir: (pluginId: string) => string;
    isWatching?: boolean | undefined;
}>) {
    const pluginBuilds = (
        await Promise.all(
            builtInPlugins.map(async (plugin) => {
                return await createBuiltInPluginBuilds({
                    pluginId: plugin.id,
                    outDir: findOutDir(plugin.id),
                    isWatching: !!isWatching,
                });
            }),
        )
    ).flat();
    const builds = pluginBuilds.map((build) => {
        const entry = {
            build,
            inputs: new Set<string>(),
            isFailed: false,
            isRunning: false,
            isQueued: false,
            /**
             * Runs the build, or when it's already running, queues one more run after it so a
             * change made mid-build isn't missed. Its return type is annotated because it calls
             * itself.
             */
            async run(): Promise<void> {
                if (entry.isRunning) {
                    entry.isQueued = true;
                    return;
                }
                entry.isRunning = true;
                try {
                    const result = await buildWithEsbuild({
                        ...build.options,
                        metafile: true,
                    });
                    entry.inputs = new Set(
                        Object.keys(result.metafile.inputs).map((input) => {
                            return resolve(build.packageDir, input);
                        }),
                    );
                    entry.isFailed = false;
                } catch {
                    /** Esbuild already logged the errors. */
                    entry.isFailed = true;
                } finally {
                    entry.isRunning = false;
                }
                if (entry.isQueued) {
                    entry.isQueued = false;
                    await entry.run();
                }
                if (builds.every((other) => !other.isRunning)) {
                    /**
                     * Esbuild's Go process keeps the memory of finished builds until it exits. The
                     * next build starts a new one.
                     */
                    await stopEsbuild();
                }
            },
        };
        return entry;
    });
    await Promise.all(builds.map(async (entry) => await entry.run()));
    if (isWatching) {
        watchBuiltInPluginBuilds(builds);
    }
    return builds.every((entry) => !entry.isFailed);
}
