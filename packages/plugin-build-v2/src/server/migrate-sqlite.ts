import {check} from '@augment-vir/assert';
import Database from 'better-sqlite3';
import {getNowInIsoString} from 'date-vir';
import {readdir, readFile} from 'node:fs/promises';
import {join} from 'node:path';

/**
 * Applies the migrations in `migrationsDir` that the SQLite database at `databasePath` doesn't have
 * yet, creating the file when it's missing. Reads the layout `prisma migrate dev` writes: one
 * folder per migration holding a `migration.sql`, named so they sort in order. Each migration runs
 * in its own transaction and is recorded in the database's `_applied_migrations` table, so one that
 * fails leaves nothing behind and runs again next time. Resolves to the names of the migrations it
 * applied.
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
        pending.forEach((migration) => {
            database.transaction(() => {
                database.exec(migration.sql);
                recordMigration.run(migration.name, getNowInIsoString());
            })();
        });
        return pending.map((migration) => migration.name);
    } finally {
        database.close();
    }
}
