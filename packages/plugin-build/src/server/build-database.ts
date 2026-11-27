import {awaitedForEach} from '@augment-vir/common';
import {
    applySqliteMigrations,
    createSqliteWorkerAdapter,
    hasErrorCode,
    sqliteWorkerFileName,
} from 'agent-storm-util';
import {readdir, rename, stat} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {PrismaClient} from './generated/client.js';

const databaseFileName = 'build.db';

/** The database's file name while the plugin's id was `build-v2`. */
const legacyDatabaseFileName = 'build-v2.db';

/**
 * Renames the database's files, and its migration backups, from their names while the plugin's id
 * was `build-v2`. The backups are renamed too because migrations only prune backups with the
 * database's current name.
 */
async function renameLegacyDatabase(dataDir: string) {
    if (!(await stat(join(dataDir, databaseFileName)).catch(() => undefined))) {
        /** The database itself goes last, so an interrupted rename never strands its WAL. */
        await awaitedForEach(
            [
                '-wal',
                '-shm',
                '',
            ],
            async (suffix) => {
                await rename(
                    join(dataDir, `${legacyDatabaseFileName}${suffix}`),
                    join(dataDir, `${databaseFileName}${suffix}`),
                ).catch((error: unknown) => {
                    if (!hasErrorCode(error, 'ENOENT')) {
                        throw error;
                    }
                });
            },
        );
    }
    const backupsDir = join(dataDir, 'migration-backups');
    const legacyBackupPrefix = `${legacyDatabaseFileName}.before-`;
    const backupNames = await readdir(backupsDir).catch((): string[] => []);
    await Promise.all(
        backupNames
            .filter((fileName) => fileName.startsWith(legacyBackupPrefix))
            .map(async (fileName) => {
                await rename(
                    join(backupsDir, fileName),
                    join(
                        backupsDir,
                        `${databaseFileName}.before-${fileName.slice(legacyBackupPrefix.length)}`,
                    ),
                );
            }),
    );
}

/**
 * Opens the plugin's database in `dataDir`, first applying the migrations the plugin build copies
 * beside the server bundle. Its queries run in the worker thread the build bundles there too.
 */
export async function openBuildDatabase(dataDir: string) {
    await renameLegacyDatabase(dataDir);
    const databasePath = resolve(dataDir, databaseFileName);
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
