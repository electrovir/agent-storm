import {assert, assertWrap} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readChatImage, saveInlineImage} from './chat-images.js';

async function withImagesDir(callback: (imagesDir: string) => Promise<void>) {
    const imagesDir = await mkdtemp(join(tmpdir(), 'chat-images-'));
    try {
        await callback(imagesDir);
    } finally {
        await rm(imagesDir, {
            recursive: true,
            force: true,
        });
    }
}

describe(readChatImage.name, () => {
    it('reads back an image saveInlineImage wrote', async () => {
        await withImagesDir(async (imagesDir) => {
            const image = {
                mimeType: 'image/png',
                dataBase64: Buffer.from('png bytes').toString('base64'),
            };
            const path = assertWrap.isDefined(
                await saveInlineImage({
                    image,
                    imagesDir,
                }),
            );
            assert.deepEquals(await readChatImage(path), image);
        });
    });

    it('rejects a file that is not an image', async () => {
        await withImagesDir(async (imagesDir) => {
            const path = join(imagesDir, 'secret.txt');
            await writeFile(path, 'secret');
            await assert.throws(readChatImage(path));
        });
    });

    it('rejects a relative path', async () => {
        await assert.throws(readChatImage('chart.png'));
    });
});

describe(saveInlineImage.name, () => {
    it('skips an image type the chat does not show', async () => {
        await withImagesDir(async (imagesDir) => {
            assert.isUndefined(
                await saveInlineImage({
                    image: {
                        mimeType: 'image/tiff',
                        dataBase64: '',
                    },
                    imagesDir,
                }),
            );
        });
    });
});
