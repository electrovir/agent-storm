import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {DriverAdapterError, type SqlDriverAdapter} from '@prisma/driver-adapter-utils';
import {build} from 'esbuild';
import {mkdtemp, rm} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {createSqliteWorkerAdapter} from './sqlite-worker-adapter.js';

function toQuery(sql: string) {
    return {
        sql,
        args: [],
        argTypes: [],
    };
}

async function readLabels(adapter: Readonly<SqlDriverAdapter>) {
    const result = await adapter.queryRaw(toQuery('SELECT "label" FROM "Item" ORDER BY "label"'));
    return result.rows.flat();
}

/**
 * Bundles the worker the way the plugin build does. Run from source, the Prisma adapter loads its
 * own nested `better-sqlite3`, which the repo's `ignore-scripts` leaves without a compiled binary;
 * the bundle loads the root copy instead, which ships prebuilt ones.
 */
async function bundleWorker(dir: string) {
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

async function withAdapter(callback: (adapter: SqlDriverAdapter) => Promise<void>) {
    const dir = await mkdtemp(join(tmpdir(), 'sqlite-worker-adapter-'));
    const adapter = await createSqliteWorkerAdapter({
        databasePath: join(dir, 'test.db'),
        workerPath: await bundleWorker(dir),
    }).connect();
    try {
        await adapter.executeScript('CREATE TABLE "Item" ("label" TEXT NOT NULL PRIMARY KEY);');
        await callback(adapter);
    } finally {
        await adapter.dispose().catch(() => undefined);
        await rm(dir, {
            recursive: true,
            force: true,
        });
    }
}

describe(createSqliteWorkerAdapter.name, () => {
    it('writes and reads rows through the worker', async () => {
        await withAdapter(async (adapter) => {
            assert.strictEquals(
                await adapter.executeRaw(toQuery('INSERT INTO "Item" ("label") VALUES (\'a\')')),
                1,
            );
            assert.deepEquals(await readLabels(adapter), [
                'a',
            ]);
        });
    });

    it('keeps a committed transaction and drops a rolled back one', async () => {
        await withAdapter(async (adapter) => {
            /**
             * Like Prisma's engine, these send the `COMMIT` and `ROLLBACK` themselves: the
             * adapter's `commit` and `rollback` only release its transaction lock.
             */
            const committed = await adapter.startTransaction();
            await committed.executeRaw(toQuery('INSERT INTO "Item" ("label") VALUES (\'kept\')'));
            await committed.executeRaw(toQuery('COMMIT'));
            await committed.commit();

            const rolledBack = await adapter.startTransaction();
            await rolledBack.executeRaw(
                toQuery('INSERT INTO "Item" ("label") VALUES (\'dropped\')'),
            );
            await rolledBack.executeRaw(toQuery('ROLLBACK'));
            await rolledBack.rollback();

            assert.deepEquals(await readLabels(adapter), [
                'kept',
            ]);
        });
    });

    it('rejects a constraint violation with a driver adapter error', async () => {
        await withAdapter(async (adapter) => {
            await adapter.executeRaw(toQuery('INSERT INTO "Item" ("label") VALUES (\'a\')'));
            await assert.throws(
                adapter.executeRaw(toQuery('INSERT INTO "Item" ("label") VALUES (\'a\')')),
                {
                    matchConstructor: DriverAdapterError,
                },
            );
        });
    });

    it('rejects calls made after dispose instead of leaving them pending', async () => {
        await withAdapter(async (adapter) => {
            await adapter.dispose();
            await assert.throws(adapter.queryRaw(toQuery('SELECT 1')), {
                matchMessage: 'SQLite worker exited',
            });
        });
    });
});
