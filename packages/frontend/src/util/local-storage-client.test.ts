import {PaneKind} from '@agent-storm/common';
import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {FrontendTab} from './frontend-tab.js';
import {localStorageClient, scrollbackLimit} from './local-storage-client.js';

describe('localStorageClient', () => {
    it('writes and removes one folder’s entry without touching the others', () => {
        localStorageClient.tabByFolder.clear();
        localStorageClient.tabByFolder.writeFolder({
            folder: '/repo-a',
            value: FrontendTab.Diff,
        });
        localStorageClient.tabByFolder.writeFolder({
            folder: '/repo-b',
            value: FrontendTab.Shell,
        });
        localStorageClient.tabByFolder.writeFolder({
            folder: '/repo-a',
            value: undefined,
        });
        assert.deepEquals(localStorageClient.tabByFolder.read(), {
            '/repo-b': FrontendTab.Shell,
        });
        localStorageClient.tabByFolder.clear();
    });
    it('discards a stored map that does not match its shape', () => {
        globalThis.localStorage.setItem(
            localStorageClient.tabByFolder.key,
            JSON.stringify({
                '/repo': 'not-a-tab',
            }),
        );
        globalThis.localStorage.setItem(
            localStorageClient.sessionIndexByFolder.key,
            JSON.stringify({
                '/repo': {
                    [PaneKind.Ai]: 'two',
                },
            }),
        );
        assert.deepEquals(
            [
                localStorageClient.tabByFolder.read(),
                localStorageClient.sessionIndexByFolder.read(),
            ],
            [
                {},
                {},
            ],
        );
        localStorageClient.tabByFolder.clear();
        localStorageClient.sessionIndexByFolder.clear();
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
