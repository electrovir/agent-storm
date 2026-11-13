import {assert} from '@augment-vir/assert';
import {getObjectTypedEntries} from '@augment-vir/common';
import {describe, it} from '@augment-vir/test';
import Database from 'better-sqlite3';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
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
});
