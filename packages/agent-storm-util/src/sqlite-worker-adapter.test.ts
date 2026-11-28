import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {DriverAdapterError, type SqlDriverAdapter} from '@prisma/driver-adapter-utils';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startPerfTrace, takePerfTrace} from './perf-trace.js';
import {createSqliteWorkerAdapter} from './sqlite-worker-adapter.js';
import {bundleSqliteWorker} from './sqlite-worker.mock.js';

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

async function withAdapter(callback: (adapter: SqlDriverAdapter) => Promise<void>) {
    const dir = await mkdtemp(join(tmpdir(), 'sqlite-worker-adapter-'));
    const adapter = await createSqliteWorkerAdapter({
        databasePath: join(dir, 'test.db'),
        workerPath: await bundleSqliteWorker(dir),
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
    it('names each query span by its statement and table', async () => {
        await withAdapter(async (adapter) => {
            const trace = await startPerfTrace(async () => {
                await adapter.executeRaw(
                    toQuery('INSERT INTO "Item" ("label") VALUES (\'first\')'),
                );
                await readLabels(adapter);
                return takePerfTrace();
            });
            assert.deepEquals(
                trace?.spans.map((span) => span.name),
                [
                    'sqlite INSERT Item',
                    'sqlite SELECT Item',
                ],
            );
        });
    });

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
