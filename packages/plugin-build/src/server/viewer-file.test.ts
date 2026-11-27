import {ViewerFileStatus, ViewerFileType} from '@agent-storm/common';
import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readViewerFile, resolveViewerPath} from './viewer-file.js';

async function withFolder(callback: (folder: string) => Promise<void>) {
    const folder = await mkdtemp(join(tmpdir(), 'viewer-file-'));
    try {
        await callback(folder);
    } finally {
        await rm(folder, {
            recursive: true,
            force: true,
        });
    }
}

describe(resolveViewerPath.name, () => {
    it('resolves relative paths against the folder and keeps absolute ones', () => {
        assert.deepEquals(
            [
                resolveViewerPath({
                    folder: '/repos/app',
                    path: 'out/page.html',
                }),
                resolveViewerPath({
                    folder: '/repos/app',
                    path: '/tmp/page.html',
                }),
                resolveViewerPath({
                    folder: '/repos/app',
                    path: '  notes.md ',
                }),
            ],
            [
                '/repos/app/out/page.html',
                '/tmp/page.html',
                '/repos/app/notes.md',
            ],
        );
    });
});

describe(readViewerFile.name, () => {
    it('reads a supported file, matching the extension case-insensitively', async () => {
        await withFolder(async (folder) => {
            await writeFile(join(folder, 'Page.HTML'), '<p>hi</p>');
            const result = await readViewerFile({
                folder,
                path: 'Page.HTML',
                knownModifiedAtMs: 0,
            });
            assert.deepEquals(
                {
                    status: result.status,
                    fileType: result.fileType,
                    mimeType: result.mimeType,
                    content: Buffer.from(result.contentBase64, 'base64').toString(),
                },
                {
                    status: ViewerFileStatus.Loaded,
                    fileType: ViewerFileType.Html,
                    mimeType: 'text/html',
                    content: '<p>hi</p>',
                },
            );
        });
    });

    it('sends no content when the known modified time still matches', async () => {
        await withFolder(async (folder) => {
            await writeFile(join(folder, 'a.md'), '# a');
            const first = await readViewerFile({
                folder,
                path: 'a.md',
                knownModifiedAtMs: 0,
            });
            const second = await readViewerFile({
                folder,
                path: 'a.md',
                knownModifiedAtMs: first.modifiedAtMs,
            });
            assert.deepEquals(
                {
                    status: second.status,
                    contentBase64: second.contentBase64,
                },
                {
                    status: ViewerFileStatus.Unchanged,
                    contentBase64: '',
                },
            );
        });
    });

    it('reports a missing file, a directory, and a file type it does not show', async () => {
        await withFolder(async (folder) => {
            await mkdir(join(folder, 'folder.md'));
            await writeFile(join(folder, 'secrets.env'), 'KEY=value');
            const statuses = await Promise.all(
                [
                    'missing.md',
                    'folder.md',
                    'secrets.env',
                ].map(async (path) => {
                    return (
                        await readViewerFile({
                            folder,
                            path,
                            knownModifiedAtMs: 0,
                        })
                    ).status;
                }),
            );
            assert.deepEquals(statuses, [
                ViewerFileStatus.NotFound,
                ViewerFileStatus.NotAFile,
                ViewerFileStatus.UnsupportedType,
            ]);
        });
    });

    it('refuses a file over the size cap', async () => {
        await withFolder(async (folder) => {
            await writeFile(join(folder, 'big.png'), Buffer.alloc(10 * 1024 * 1024 + 1));
            const result = await readViewerFile({
                folder,
                path: 'big.png',
                knownModifiedAtMs: 0,
            });
            assert.deepEquals(
                {
                    status: result.status,
                    contentBase64: result.contentBase64,
                },
                {
                    status: ViewerFileStatus.TooLarge,
                    contentBase64: '',
                },
            );
        });
    });
});
