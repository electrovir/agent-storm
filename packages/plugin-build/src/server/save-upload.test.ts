import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readUpload, saveUpload} from './save-upload.js';

async function withUploadsDir(callback: (root: string) => Promise<void>) {
    const root = await mkdtemp(join(tmpdir(), 'save-upload-'));
    try {
        await callback(root);
    } finally {
        await rm(root, {
            recursive: true,
            force: true,
        });
    }
}

describe(readUpload.name, () => {
    it('reads back what saveUpload wrote', async () => {
        await withUploadsDir(async (root) => {
            const uploadsDir = join(root, 'uploads');
            const dataBase64 = Buffer.from('hello').toString('base64');
            const path = await saveUpload({
                filename: '../../evil name.txt',
                dataBase64,
                uploadsDir,
            });
            assert.strictEquals(
                await readUpload({
                    path,
                    uploadsDir,
                }),
                dataBase64,
            );
        });
    });

    it('rejects paths outside the uploads folder', async () => {
        await withUploadsDir(async (root) => {
            const uploadsDir = join(root, 'uploads');
            const siblingFile = join(`${uploadsDir}-other`, 'file.txt');
            await writeFile(join(root, 'secret.txt'), 'secret');
            await assert.throws(
                readUpload({
                    path: join(uploadsDir, '..', 'secret.txt'),
                    uploadsDir,
                }),
                {
                    matchMessage: 'Not an uploaded file',
                },
            );
            await assert.throws(
                readUpload({
                    path: siblingFile,
                    uploadsDir,
                }),
                {
                    matchMessage: 'Not an uploaded file',
                },
            );
        });
    });
});
