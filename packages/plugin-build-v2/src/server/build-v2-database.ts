import {
    applySqliteMigrations,
    createSqliteWorkerAdapter,
    sqliteWorkerFileName,
} from 'agent-storm-util';
import {resolve} from 'node:path';
import {PrismaClient} from './generated/client.js';

/**
 * Opens the plugin's database in `dataDir`, first applying the migrations the plugin build copies
 * beside the server bundle. Its queries run in the worker thread the build bundles there too.
 */
export async function openBuildV2Database(dataDir: string) {
    const databasePath = resolve(dataDir, 'build-v2.db');
    await applySqliteMigrations({
        databasePath,
        migrationsDir: resolve(import.meta.dirname, 'migrations'),
    });
    return new PrismaClient({
        adapter: createSqliteWorkerAdapter({
            databasePath,
            workerPath: resolve(import.meta.dirname, sqliteWorkerFileName),
        }),
    });
}
