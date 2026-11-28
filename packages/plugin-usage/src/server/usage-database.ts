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
export async function openUsageDatabase(
    dataDir: string,
    /** Tests point this at the package's own migrations, since they run unbundled. */
    migrationsDir = resolve(import.meta.dirname, 'migrations'),
    /** Tests point this at a worker they bundle, for the same reason. */
    workerPath = resolve(import.meta.dirname, sqliteWorkerFileName),
) {
    const databasePath = resolve(dataDir, 'usage.db');
    await applySqliteMigrations({
        databasePath,
        migrationsDir,
    });
    return new PrismaClient({
        adapter: createSqliteWorkerAdapter({
            databasePath,
            workerPath,
        }),
    });
}
