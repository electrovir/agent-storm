import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {defineFolderSetting, localStorageClient, scrollbackLimit} from './local-storage-client.js';

describe('localStorageClient', () => {
    const fileByFolder = defineFolderSetting({
        key: 'agent-storm:test:file-by-folder',
        valueShape: '',
    });

    it('writes and removes one folder’s entry without touching the others', () => {
        fileByFolder.clear();
        fileByFolder.writeFolder({
            folder: '/repo-a',
            value: 'a.ts',
        });
        fileByFolder.writeFolder({
            folder: '/repo-b',
            value: 'b.ts',
        });
        fileByFolder.writeFolder({
            folder: '/repo-a',
            value: undefined,
        });
        assert.deepEquals(fileByFolder.read(), {
            '/repo-b': 'b.ts',
        });
        fileByFolder.clear();
    });
    it('discards a stored map that does not match its shape', () => {
        globalThis.localStorage.setItem(
            fileByFolder.key,
            JSON.stringify({
                '/repo': 5,
            }),
        );
        assert.deepEquals(fileByFolder.read(), {});
        fileByFolder.clear();
    });
    it('clamps a stored number into its bounds and rounds integer settings', () => {
        globalThis.localStorage.setItem(localStorageClient.scrollbackLimit.key, '12.6');
        const belowMin = localStorageClient.scrollbackLimit.read();
        globalThis.localStorage.setItem(localStorageClient.scrollbackLimit.key, '1234.4');
        const rounded = localStorageClient.scrollbackLimit.read();
        globalThis.localStorage.setItem(localStorageClient.scrollbackLimit.key, 'junk');
        const fallback = localStorageClient.scrollbackLimit.read();
        localStorageClient.scrollbackLimit.clear();
        assert.deepEquals(
            [
                belowMin,
                rounded,
                fallback,
            ],
            [
                scrollbackLimit.min,
                1234,
                scrollbackLimit.default,
            ],
        );
    });
});
