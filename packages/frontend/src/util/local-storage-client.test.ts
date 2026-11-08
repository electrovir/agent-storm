import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {localStorageClient, scrollbackLimit} from './local-storage-client.js';
import {DiffView} from './pane-layout.js';

describe('localStorageClient', () => {
    it('writes and removes one folder’s entry without touching the others', () => {
        localStorageClient.diffViewByFolder.clear();
        localStorageClient.diffViewByFolder.writeFolder({
            folder: '/repo-a',
            value: DiffView.ManualReview,
        });
        localStorageClient.diffViewByFolder.writeFolder({
            folder: '/repo-b',
            value: DiffView.Source,
        });
        localStorageClient.diffViewByFolder.writeFolder({
            folder: '/repo-a',
            value: undefined,
        });
        assert.deepEquals(localStorageClient.diffViewByFolder.read(), {
            '/repo-b': DiffView.Source,
        });
        localStorageClient.diffViewByFolder.clear();
    });
    it('discards a stored map that does not match its shape', () => {
        globalThis.localStorage.setItem(
            localStorageClient.diffViewByFolder.key,
            JSON.stringify({
                '/repo': 'not-a-view',
            }),
        );
        assert.deepEquals(localStorageClient.diffViewByFolder.read(), {});
        localStorageClient.diffViewByFolder.clear();
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
