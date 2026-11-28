import {build} from 'esbuild';
import {createRequire} from 'node:module';
import {join, resolve} from 'node:path';

/**
 * Bundles the SQLite worker into `dir` the way the plugin build does, for tests that open a real
 * database. Run from source, the Prisma adapter loads its own nested `better-sqlite3`, which the
 * repo's `ignore-scripts` leaves without a compiled binary; the bundle loads the root copy instead,
 * which ships prebuilt ones.
 */
export async function bundleSqliteWorker(dir: string) {
    /** `.mjs` because nothing marks the temp folder as ES modules. */
    const workerPath = join(dir, 'sqlite-worker.mjs');
    const betterSqlitePath = createRequire(import.meta.url).resolve('better-sqlite3');
    await build({
        entryPoints: [
            resolve(import.meta.dirname, 'sqlite-worker.ts'),
        ],
        outfile: workerPath,
        bundle: true,
        format: 'esm',
        platform: 'node',
        logLevel: 'warning',
        banner: {
            js: "import {createRequire as createBannerRequire} from 'node:module'; const require = createBannerRequire(import.meta.url);",
        },
        plugins: [
            {
                name: 'root-better-sqlite3',
                setup(pluginBuild) {
                    pluginBuild.onResolve(
                        {
                            filter: /^better-sqlite3$/,
                        },
                        () => {
                            return {
                                path: betterSqlitePath,
                                external: true,
                            };
                        },
                    );
                },
            },
        ],
    });
    return workerPath;
}
