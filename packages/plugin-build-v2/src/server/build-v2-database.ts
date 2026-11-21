import {applySqliteMigrations} from 'agent-storm-util';
import {resolve} from 'node:path';
import {createPrismaClient, PrismaDatabaseEngine} from 'prisma-vir';
import {PrismaClient} from './generated/client.js';

/**
 * Opens the plugin's database in `dataDir`, first applying the migrations the plugin build copies
 * beside the server bundle.
 */
export async function openBuildV2Database(dataDir: string) {
    const databasePath = resolve(dataDir, 'build-v2.db');
    await applySqliteMigrations({
        databasePath,
        migrationsDir: resolve(import.meta.dirname, 'migrations'),
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
