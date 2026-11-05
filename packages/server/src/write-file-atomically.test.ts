import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {mkdtemp, readdir, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {writeFileAtomically} from './write-file-atomically.js';

describe(writeFileAtomically.name, () => {
    it('creates missing folders and leaves no temp file behind', async () => {
        const root = await mkdtemp(join(tmpdir(), 'write-file-atomically-'));
        try {
            const path = join(root, 'nested', 'state.json');
            await writeFileAtomically({
                path,
                contents: 'first',
            });
            await writeFileAtomically({
                path,
                contents: 'second',
            });
            assert.deepEquals(
                {
                    contents: await readFile(path, 'utf8'),
                    files: await readdir(join(root, 'nested')),
                },
                {
                    contents: 'second',
                    files: [
                        'state.json',
                    ],
                },
            );
        } finally {
            await rm(root, {
                recursive: true,
                force: true,
            });
        }
    });
});
