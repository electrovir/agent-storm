import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {execFile} from 'node:child_process';
import {mkdir, mkdtemp, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';

describe('agent-storm-config bin', () => {
    it('prints the resolved settings', async () => {
        /**
         * The bin finds its files from its working directory, which macOS reports through
         * `/private`.
         */
        const root = await realpath(await mkdtemp(join(tmpdir(), 'agent-storm-config-bin-')));
        try {
            await mkdir(join(root, '.agent-storm'));
            await writeFile(
                join(root, '.agent-storm', 'agent-storm.config.json'),
                JSON.stringify({
                    reviewSkill: '/vir-review',
                }),
            );
            const {stdout} = await promisify(execFile)(
                process.execPath,
                [
                    join(import.meta.dirname, 'agent-storm-config.script.ts'),
                ],
                {
                    cwd: root,
                },
            );
            assert.deepEquals(JSON.parse(stdout), {
                configPaths: [
                    join(root, '.agent-storm/agent-storm.config.json'),
                ],
                skippedConfigPaths: [],
                postWorktreeCmd: '',
                reviewSkill: '/vir-review',
            });
        } finally {
            await rm(root, {
                recursive: true,
                force: true,
            });
        }
    });
});
