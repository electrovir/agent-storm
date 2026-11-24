import {assert} from '@augment-vir/assert';
import {awaitedForEach, getObjectTypedEntries} from '@augment-vir/common';
import {describe, it} from '@augment-vir/test';
import Database from 'better-sqlite3';
import {mkdir, mkdtemp, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {applySqliteMigrations} from './migrate-sqlite.js';

async function createMigrationsFixture(migrations: Readonly<Record<string, string>>) {
    const dir = await mkdtemp(join(tmpdir(), 'migrate-sqlite-'));
    const migrationsDir = join(dir, 'migrations');
    await Promise.all(
        getObjectTypedEntries(migrations).map(
            async ([
                name,
                sql,
            ]) => {
                await mkdir(join(migrationsDir, name), {
                    recursive: true,
                });
                await writeFile(join(migrationsDir, name, 'migration.sql'), sql);
            },
        ),
    );
    return {
        dir,
        migrationsDir,
        databasePath: join(dir, 'test.db'),
    };
}

function readColumn({
    databasePath,
    sql,
}: Readonly<{
    databasePath: string;
    sql: string;
}>) {
    const database = new Database(databasePath);
    try {
        return database.prepare(sql).pluck().all();
    } finally {
        database.close();
    }
}

function readTableNames(databasePath: string) {
    const database = new Database(databasePath);
    try {
        return database
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
            .pluck()
            .all();
    } finally {
        database.close();
    }
}

describe(applySqliteMigrations.name, () => {
    it('creates the database and applies every migration in order', async () => {
        const fixture = await createMigrationsFixture({
            '2_add_column': 'ALTER TABLE "First" ADD COLUMN "label" TEXT;',
            '1_init': 'CREATE TABLE "First" ("id" TEXT NOT NULL PRIMARY KEY);',
        });
        try {
            assert.deepEquals(await applySqliteMigrations(fixture), [
                '1_init',
                '2_add_column',
            ]);
            assert.deepEquals(readTableNames(fixture.databasePath), [
                'First',
                '_applied_migrations',
            ]);
            assert.deepEquals(
                readColumn({
                    databasePath: fixture.databasePath,
                    sql: 'PRAGMA journal_mode',
                }),
                [
                    'wal',
                ],
            );
        } finally {
            await rm(fixture.dir, {
                recursive: true,
                force: true,
            });
        }
    });

    it('skips migrations the database already has', async () => {
        const fixture = await createMigrationsFixture({
            '1_init': 'CREATE TABLE "First" ("id" TEXT NOT NULL PRIMARY KEY);',
        });
        try {
            await applySqliteMigrations(fixture);
            await mkdir(join(fixture.migrationsDir, '2_second'));
            await writeFile(
                join(fixture.migrationsDir, '2_second', 'migration.sql'),
                'CREATE TABLE "Second" ("id" TEXT NOT NULL PRIMARY KEY);',
            );
            assert.deepEquals(await applySqliteMigrations(fixture), [
                '2_second',
            ]);
            assert.deepEquals(await applySqliteMigrations(fixture), []);
        } finally {
            await rm(fixture.dir, {
                recursive: true,
                force: true,
            });
        }
    });

    it('keeps rows that cascade from a table a migration redefines', async () => {
        const fixture = await createMigrationsFixture({
            '1_init': [
                'CREATE TABLE "Parent" ("id" TEXT NOT NULL PRIMARY KEY);',
                'CREATE TABLE "Child" ("id" TEXT NOT NULL PRIMARY KEY, "parentId" TEXT NOT NULL REFERENCES "Parent" ("id") ON DELETE CASCADE);',
            ].join('\n'),
            '2_seed': [
                'INSERT INTO "Parent" ("id") VALUES (\'parent\');',
                'INSERT INTO "Child" ("id", "parentId") VALUES (\'child\', \'parent\');',
            ].join('\n'),
            /** What `prisma migrate dev` writes to add a column SQLite can't add in place. */
            '3_redefine': [
                'PRAGMA defer_foreign_keys=ON;',
                'PRAGMA foreign_keys=OFF;',
                'CREATE TABLE "new_Parent" ("id" TEXT NOT NULL PRIMARY KEY, "label" TEXT NOT NULL DEFAULT \'\');',
                'INSERT INTO "new_Parent" ("id") SELECT "id" FROM "Parent";',
                'DROP TABLE "Parent";',
                'ALTER TABLE "new_Parent" RENAME TO "Parent";',
                'PRAGMA foreign_keys=ON;',
                'PRAGMA defer_foreign_keys=OFF;',
            ].join('\n'),
        });
        try {
            await applySqliteMigrations(fixture);
            assert.deepEquals(
                readColumn({
                    databasePath: fixture.databasePath,
                    sql: 'SELECT "id" FROM "Child"',
                }),
                [
                    'child',
                ],
            );
        } finally {
            await rm(fixture.dir, {
                recursive: true,
                force: true,
            });
        }
    });

    it('rolls back a migration that deletes rows, after backing up the database', async () => {
        const fixture = await createMigrationsFixture({
            '1_init': [
                'CREATE TABLE "First" ("id" TEXT NOT NULL PRIMARY KEY);',
                'INSERT INTO "First" ("id") VALUES (\'kept\');',
            ].join('\n'),
        });
        try {
            await applySqliteMigrations(fixture);
            await mkdir(join(fixture.migrationsDir, '2_delete'));
            await writeFile(
                join(fixture.migrationsDir, '2_delete', 'migration.sql'),
                'DELETE FROM "First";',
            );
            await assert.throws(applySqliteMigrations(fixture), {
                matchMessage: 'deleted rows from First',
            });
            assert.deepEquals(
                readColumn({
                    databasePath: fixture.databasePath,
                    sql: 'SELECT "id" FROM "First"',
                }),
                [
                    'kept',
                ],
            );
            assert.deepEquals(
                readColumn({
                    databasePath: fixture.databasePath,
                    sql: 'SELECT "name" FROM "_applied_migrations"',
                }),
                [
                    '1_init',
                ],
            );
            assert.deepEquals(await readdir(join(fixture.dir, 'migration-backups')), [
                'test.db.before-2_delete.bak',
            ]);
        } finally {
            await rm(fixture.dir, {
                recursive: true,
                force: true,
            });
        }
    });

    it('keeps only the newest backups', async () => {
        const fixture = await createMigrationsFixture({
            '1_init': 'CREATE TABLE "First" ("id" TEXT NOT NULL PRIMARY KEY);',
        });
        try {
            await applySqliteMigrations(fixture);
            await awaitedForEach(
                [
                    '2_a',
                    '3_b',
                    '4_c',
                    '5_d',
                ],
                async (name) => {
                    await mkdir(join(fixture.migrationsDir, name));
                    await writeFile(
                        join(fixture.migrationsDir, name, 'migration.sql'),
                        `CREATE TABLE "${name}" ("id" TEXT NOT NULL PRIMARY KEY);`,
                    );
                    await applySqliteMigrations(fixture);
                },
            );
            assert.deepEquals(await readdir(join(fixture.dir, 'migration-backups')), [
                'test.db.before-3_b.bak',
                'test.db.before-4_c.bak',
                'test.db.before-5_d.bak',
            ]);
        } finally {
            await rm(fixture.dir, {
                recursive: true,
                force: true,
            });
        }
    });
});
