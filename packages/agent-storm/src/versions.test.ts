import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {execFile} from 'node:child_process';
import {mkdtemp, readdir, readFile, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {
    activateVersion,
    installVersion,
    isNewerVersion,
    readActiveVersions,
    rejectVersion,
} from './versions.js';

/** A release tarball with no dependencies, so installing it needs no network. */
async function createFakeTarball() {
    const sourceDir = await mkdtemp(join(tmpdir(), 'agent-storm-fake-release-'));
    const packageJson = {
        name: 'agent-storm-release',
        private: true,
        type: 'module',
    };
    await Promise.all([
        writeFile(join(sourceDir, 'package.json'), JSON.stringify(packageJson)),
        writeFile(
            join(sourceDir, 'package-lock.json'),
            JSON.stringify({
                ...packageJson,
                lockfileVersion: 3,
                requires: true,
                packages: {
                    '': packageJson,
                },
            }),
        ),
        writeFile(join(sourceDir, 'marker.txt'), 'installed'),
    ]);
    const tarballPath = join(await mkdtemp(join(tmpdir(), 'agent-storm-fake-tarball-')), 'a.tgz');
    await promisify(execFile)('tar', [
        '-czf',
        tarballPath,
        '-C',
        sourceDir,
        '.',
    ]);
    return tarballPath;
}

describe(installVersion.name, () => {
    it('installs a tarball and leaves no staging folder', async () => {
        const versionsDir = await mkdtemp(join(tmpdir(), 'agent-storm-versions-'));
        const versionDir = await installVersion({
            versionsDir,
            version: 'v1.2.3',
            tarballPath: await createFakeTarball(),
        });

        assert.strictEquals(await readFile(join(versionDir, 'marker.txt'), 'utf8'), 'installed');
        assert.deepEquals(await readdir(versionsDir), [
            'v1.2.3',
        ]);
    });
    it('rejects a version that is not a release tag', async () => {
        await assert.throws(
            installVersion({
                versionsDir: await mkdtemp(join(tmpdir(), 'agent-storm-versions-')),
                version: '../v1.2.3',
                tarballPath: 'unused.tgz',
            }),
        );
    });
});

describe(activateVersion.name, () => {
    it('keeps the replaced version to roll back to', async () => {
        const versionsDir = await mkdtemp(join(tmpdir(), 'agent-storm-versions-'));
        const tarballPath = await createFakeTarball();
        await installVersion({
            versionsDir,
            version: 'v1.0.0',
            tarballPath,
        });
        await installVersion({
            versionsDir,
            version: 'v1.1.0',
            tarballPath,
        });

        await activateVersion({
            versionsDir,
            version: 'v1.0.0',
        });
        await activateVersion({
            versionsDir,
            version: 'v1.1.0',
        });
        await activateVersion({
            versionsDir,
            version: 'v1.1.0',
        });

        assert.deepEquals(await readActiveVersions(versionsDir), {
            active: 'v1.1.0',
            previous: 'v1.0.0',
        });
    });
    it('refuses a version that is not installed', async () => {
        await assert.throws(
            activateVersion({
                versionsDir: await mkdtemp(join(tmpdir(), 'agent-storm-versions-')),
                version: 'v9.9.9',
            }),
        );
    });
});

describe(isNewerVersion.name, () => {
    it('compares each number, not the text', () => {
        assert.isTrue(
            isNewerVersion({
                version: 'v1.10.0',
                than: 'v1.9.0',
            }),
        );
    });
    it('is false for the same version', () => {
        assert.isFalse(
            isNewerVersion({
                version: 'v1.2.3',
                than: 'v1.2.3',
            }),
        );
    });
});

describe(rejectVersion.name, () => {
    it('falls back to the previous version when rejecting the active one', async () => {
        const versionsDir = await mkdtemp(join(tmpdir(), 'agent-storm-versions-'));
        const tarballPath = await createFakeTarball();
        await installVersion({
            versionsDir,
            version: 'v1.0.0',
            tarballPath,
        });
        await installVersion({
            versionsDir,
            version: 'v1.1.0',
            tarballPath,
        });
        await activateVersion({
            versionsDir,
            version: 'v1.0.0',
        });
        await activateVersion({
            versionsDir,
            version: 'v1.1.0',
        });

        await rejectVersion({
            versionsDir,
            version: 'v1.1.0',
        });

        assert.deepEquals(await readActiveVersions(versionsDir), {
            active: 'v1.0.0',
            rejected: 'v1.1.0',
        });
    });
    it('keeps the active and previous versions when rejecting another version', async () => {
        const versionsDir = await mkdtemp(join(tmpdir(), 'agent-storm-versions-'));
        const tarballPath = await createFakeTarball();
        await Promise.all(
            [
                'v1.0.0',
                'v1.1.0',
                'v1.2.0',
            ].map(async (version) => {
                await installVersion({
                    versionsDir,
                    version,
                    tarballPath,
                });
            }),
        );
        await activateVersion({
            versionsDir,
            version: 'v1.0.0',
        });
        await activateVersion({
            versionsDir,
            version: 'v1.1.0',
        });

        await rejectVersion({
            versionsDir,
            version: 'v1.2.0',
        });

        assert.deepEquals(await readActiveVersions(versionsDir), {
            active: 'v1.1.0',
            previous: 'v1.0.0',
            rejected: 'v1.2.0',
        });
    });
    it('clears the rejection when the rejected version is activated again', async () => {
        const versionsDir = await mkdtemp(join(tmpdir(), 'agent-storm-versions-'));
        const tarballPath = await createFakeTarball();
        await installVersion({
            versionsDir,
            version: 'v1.0.0',
            tarballPath,
        });
        await installVersion({
            versionsDir,
            version: 'v1.1.0',
            tarballPath,
        });
        await activateVersion({
            versionsDir,
            version: 'v1.0.0',
        });
        await rejectVersion({
            versionsDir,
            version: 'v1.1.0',
        });

        await activateVersion({
            versionsDir,
            version: 'v1.1.0',
        });

        assert.deepEquals(await readActiveVersions(versionsDir), {
            active: 'v1.1.0',
            previous: 'v1.0.0',
        });
    });
});
