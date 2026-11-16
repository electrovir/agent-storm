import {assertWrap, check} from '@augment-vir/assert';
import Database from 'better-sqlite3';
import {getNowInIsoString} from 'date-vir';
import {mkdir, readdir, readFile, rm, stat} from 'node:fs/promises';
import {basename, dirname, join} from 'node:path';

/** How many pre-migration backups of a database to keep. Older ones are deleted. */
const keptBackupCount = 3;

/**
 * Copies the database into a `migration-backups` folder beside it, then deletes all but the newest
 * backups. Backup names start with the database's name and end with the first migration they
 * precede, whose timestamp prefix sorts them oldest first.
 */
async function backUpDatabase({
    database,
    databasePath,
    nextMigrationName,
}: Readonly<{
    database: Database.Database;
    databasePath: string;
    nextMigrationName: string;
}>) {
    const backupsDir = join(dirname(databasePath), 'migration-backups');
    const backupPrefix = `${basename(databasePath)}.before-`;
    await mkdir(backupsDir, {
        recursive: true,
    });
    await database.backup(join(backupsDir, `${backupPrefix}${nextMigrationName}.bak`));
    const backupNames = (await readdir(backupsDir))
        .filter((fileName) => fileName.startsWith(backupPrefix))
        .toSorted();
    await Promise.all(
        backupNames.slice(0, -keptBackupCount).map(async (fileName) => {
            await rm(join(backupsDir, fileName));
        }),
    );
}

function countTableRows(database: Readonly<Database.Database>) {
    return database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .pluck()
        .all()
        .filter(check.isString)
        .map((tableName) => {
            return {
                tableName,
                rowCount: assertWrap.isNumber(
                    database.prepare(`SELECT COUNT(*) FROM "${tableName}"`).pluck().get(),
                ),
            };
        });
}

/**
 * Applies the migrations in `migrationsDir` that the SQLite database at `databasePath` doesn't have
 * yet, creating the file when it's missing. Reads the layout `prisma migrate dev` writes: one
 * folder per migration holding a `migration.sql`, named so they sort in order. Each migration runs
 * in its own transaction and is recorded in the database's `_applied_migrations` table, so one that
 * fails leaves nothing behind and runs again next time. Resolves to the names of the migrations it
 * applied.
 *
 * Before applying any to an existing database, copies it into a `migration-backups` folder beside
 * it, keeping only the newest few copies. A migration that leaves fewer rows in a table that still
 * exists is rolled back and throws, because a schema change never means to delete data. A migration
 * that deletes rows on purpose can't run here.
 *
 * Unlike `prisma migrate deploy`, this needs neither the Prisma CLI nor its schema engine, so it
 * works from a bundled app.
 */
export async function applySqliteMigrations({
    databasePath,
    migrationsDir,
}: Readonly<{
    databasePath: string;
    migrationsDir: string;
}>) {
    const migrations = await Promise.all(
        (
            await readdir(migrationsDir, {
                withFileTypes: true,
            })
        )
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name)
            .toSorted()
            .map(async (name) => {
                return {
                    name,
                    sql: await readFile(join(migrationsDir, name, 'migration.sql'), 'utf8'),
                };
            }),
    );
    const isExistingDatabase = !!(await stat(databasePath).catch(() => undefined));
    const database = new Database(databasePath);
    try {
        database.exec(
            'CREATE TABLE IF NOT EXISTS "_applied_migrations" ("name" TEXT NOT NULL PRIMARY KEY, "appliedAt" TEXT NOT NULL)',
        );
        const appliedNames = database
            .prepare('SELECT "name" FROM "_applied_migrations"')
            .pluck()
            .all()
            .filter(check.isString);
        const recordMigration = database.prepare(
            'INSERT INTO "_applied_migrations" ("name", "appliedAt") VALUES (?, ?)',
        );
        const pending = migrations.filter((migration) => !appliedNames.includes(migration.name));
        if (isExistingDatabase && pending[0]) {
            await backUpDatabase({
                database,
                databasePath,
                nextMigrationName: pending[0].name,
            });
        }
        /**
         * SQLite ignores `PRAGMA foreign_keys` inside a transaction, so the `foreign_keys=OFF` that
         * Prisma writes around a redefined table does nothing there. With foreign keys on, that
         * table's `DROP TABLE` cascade-deletes every row referencing it.
         */
        database.pragma('foreign_keys = OFF');
        pending.forEach((migration) => {
            database.transaction(() => {
                const rowCountsBefore = countTableRows(database);
                database.exec(migration.sql);
                if (database.prepare('PRAGMA foreign_key_check').all().length) {
                    throw new Error(
                        `Migration ${migration.name} left rows whose foreign keys match no row.`,
                    );
                }
                const rowCountsAfter = countTableRows(database);
                const shrunkTableNames = rowCountsBefore
                    .filter((before) => {
                        const after = rowCountsAfter.find(
                            (counts) => counts.tableName === before.tableName,
                        );
                        return after && after.rowCount < before.rowCount;
                    })
                    .map((before) => before.tableName);
                if (shrunkTableNames.length) {
                    throw new Error(
                        `Migration ${migration.name} deleted rows from ${shrunkTableNames.join(', ')}, so it was rolled back.`,
                    );
                }
                recordMigration.run(migration.name, getNowInIsoString());
            })();
        });
        return pending.map((migration) => migration.name);
    } finally {
        database.close();
    }
}
