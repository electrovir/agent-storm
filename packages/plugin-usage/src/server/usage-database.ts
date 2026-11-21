import {applySqliteMigrations} from 'agent-storm-util';
import {resolve} from 'node:path';
import {createPrismaClient, PrismaDatabaseEngine} from 'prisma-vir';
import {PrismaClient} from './generated/client.js';

/**
 * Opens the plugin's database in `dataDir`, first applying the migrations the plugin build copies
 * beside the server bundle.
 */
export async function openUsageDatabase(
    dataDir: string,
    /** Tests point this at the package's own migrations, since they run unbundled. */
    migrationsDir = resolve(import.meta.dirname, 'migrations'),
) {
    const databasePath = resolve(dataDir, 'usage.db');
    await applySqliteMigrations({
        databasePath,
        migrationsDir,
    });
    const {prismaClient} = await createPrismaClient(PrismaDatabaseEngine.Sqlite, PrismaClient, {
        /**
         * Prisma-vir reads this only to create a database file that's missing, which the migrations
         * above always create first.
         */
        configPath: '',
        connection: {
            liveConnection: {
                filePath: databasePath,
            },
        },
    });
    return prismaClient;
}
