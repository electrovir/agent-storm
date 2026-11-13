// cspell:words unbuilt
import {pluginManifestFileName, pluginManifestShape} from '@agent-storm/common';
import {createPluginEsbuildPlugin} from '@agent-storm/core/build';
import {monorepoRoot} from '@agent-storm/server/src/file-paths.js';
import {typedObjectFromEntries} from '@augment-vir/common';
import {runShellCommand} from '@augment-vir/node';
import {builtInPlugins} from 'agent-storm';
import {context, type BuildOptions, type Plugin} from 'esbuild';
import {copyFile, cp, mkdir, readdir, readFile, stat} from 'node:fs/promises';
import {resolve} from 'node:path';
import {assertValidShape} from 'object-shape-tester';

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
 * activity added to the manifest reaches the running app with the bundle that renders it. The
 * manifest isn't imported by any source file, so the entry's load lists it for esbuild's watch.
 */
function createManifestCopyPlugin({
    manifestPath,
    entryPath,
    outDir,
}: Readonly<{
    manifestPath: string;
    entryPath: string;
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
            build.onLoad(
                {
                    filter: /index\.ts$/,
                },
                async (args) => {
                    if (args.path !== entryPath) {
                        return undefined;
                    }
                    return {
                        contents: await readFile(entryPath, 'utf8'),
                        loader: 'ts',
                        watchFiles: [
                            manifestPath,
                        ],
                    };
                },
            );
        },
    };
}

async function createBuiltInPluginBuilds({
    pluginId,
    outDir,
    isWatching,
}: Readonly<{
    pluginId: string;
    outDir: string;
    isWatching: boolean;
}>) {
    const packageDir = findPluginPackageDir(pluginId);
    const manifestPath = resolve(packageDir, pluginManifestFileName);
    const manifest: unknown = JSON.parse(await readFile(manifestPath, 'utf8'));
    assertValidShape(manifest, pluginManifestShape);
    await mkdir(outDir, {
        recursive: true,
    });
    /** A server part reads its Markdown files from beside its bundle. */
    const serverDir = resolve(packageDir, 'src', 'server');
    await Promise.all(
        (await readdir(serverDir).catch(() => []))
            .filter((fileName) => fileName.endsWith('.md'))
            .map(async (fileName) => {
                await copyFile(resolve(serverDir, fileName), resolve(outDir, fileName));
            }),
    );
    /** A server part applies its database migrations from beside its bundle. */
    const migrationsDir = resolve(packageDir, 'prisma', 'migrations');
    if (await stat(migrationsDir).catch(() => undefined)) {
        await cp(migrationsDir, resolve(outDir, 'migrations'), {
            recursive: true,
        });
    }
    await generatePrismaClient(packageDir);
    const browserEntryPath = resolve(packageDir, 'src', 'index.ts');
    const shared: BuildOptions = {
        bundle: true,
        format: 'esm',
        logLevel: 'warning',
        absWorkingDir: packageDir,
        /** Each plugin bundles its own copy of its dependencies, so a release minifies them. */
        minify: !isWatching,
    };
    return await Promise.all([
        context({
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
                    entryPath: browserEntryPath,
                    outDir,
                }),
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
        }),
        ...(manifest.serverEntry
            ? [
                  context({
                      ...shared,
                      platform: 'node',
                      target: 'node22',
                      entryPoints: [
                          resolve(packageDir, 'src', 'server', `${pluginId}-server.ts`),
                      ],
                      outfile: resolve(outDir, manifest.serverEntry),
                      external: [
                          /**
                           * Native modules, and the Claude Agent SDK, which runs Claude Code from a
                           * platform-specific package it finds next to its own.
                           */
                          'node-pty',
                          'better-sqlite3',
                          '@anthropic-ai/claude-agent-sdk',
                          /**
                           * Prisma-vir's index re-exports test helpers reaching Playwright, which
                           * esbuild must resolve before dropping them as unused and can't.
                           */
                          'playwright-core',
                          'chromium-bidi',
                      ],
                      banner: {
                          /**
                           * Bundled CommonJS dependencies `require` Node's built-ins, which ES
                           * modules lack. The import is renamed because bundled dependencies
                           * declare their own top-level `createRequire`.
                           */
                          js: "import {createRequire as createBannerRequire} from 'node:module'; const require = createBannerRequire(import.meta.url);",
                      },
                  }),
              ]
            : []),
    ]);
}

/**
 * Builds every built-in plugin from its `packages/plugin-<id>` package into the folder `findOutDir`
 * gives for its id, laid out as a plugin folder: its manifest, its browser bundle, and its server
 * bundle when it has a server part. With `isWatching`, rebuilds each bundle whenever its sources
 * change, until the process exits. A failed build is logged and leaves that plugin unbuilt, so the
 * app still starts.
 */
export async function buildBuiltInPlugins({
    findOutDir,
    isWatching,
}: Readonly<{
    findOutDir: (pluginId: string) => string;
    isWatching?: boolean | undefined;
}>) {
    const builds = (
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
    const results = await Promise.allSettled(builds.map(async (build) => await build.rebuild()));
    await Promise.all(
        builds.map(async (build) => {
            if (isWatching) {
                await build.watch();
            } else {
                await build.dispose();
            }
        }),
    );
    return results.every((result) => result.status === 'fulfilled');
}
