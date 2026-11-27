import {assert, waitUntil} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {chmod, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parseFolderEnv, readFolderEnv} from './folder-env.js';

const marker = '\0agent-storm-folder-env\0';

describe(parseFolderEnv.name, () => {
    it('ignores output before the marker and keeps "=" inside values', () => {
        assert.deepEquals(
            parseFolderEnv(
                [
                    'welcome banner',
                    marker,
                    'A=b=c\0HOME=/home/someone\0',
                ].join(''),
            ),
            {
                A: 'b=c',
                HOME: '/home/someone',
            },
        );
    });

    it('throws when the marker is missing', () => {
        assert.throws(() => parseFolderEnv('A=b\0'), {
            matchMessage: 'no environment',
        });
    });
});

describe(readFolderEnv.name, () => {
    it('answers from the last read while it reads again', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'folder-env-test-'));
        const shellPath = join(dir, 'shell.sh');
        /** Stands in for the login shell, counting how many times it was started. */
        await writeFile(
            shellPath,
            [
                '#!/bin/sh',
                'count=$(($(cat count 2>/dev/null || echo 0) + 1))',
                'echo "$count" > count',
                String.raw`printf '\000agent-storm-folder-env\000READ=%s\000' "$count"`,
            ].join('\n'),
        );
        await chmod(shellPath, 0o755);
        const originalShell = process.env.SHELL;
        process.env.SHELL = shellPath;
        try {
            const reads = [
                (await readFolderEnv(dir))?.READ,
                (await readFolderEnv(dir))?.READ,
            ];
            const laterRead = await waitUntil.isTruthy(
                async () => {
                    const read = (await readFolderEnv(dir))?.READ;
                    return read === '1' ? undefined : read;
                },
                {
                    interval: {
                        milliseconds: 25,
                    },
                    timeout: {
                        seconds: 5,
                    },
                },
            );
            assert.deepEquals(
                [
                    ...reads,
                    laterRead,
                ],
                [
                    '1',
                    '1',
                    '2',
                ],
            );
        } finally {
            process.env.SHELL = originalShell;
            await rm(dir, {
                recursive: true,
                force: true,
            });
        }
    });
});
