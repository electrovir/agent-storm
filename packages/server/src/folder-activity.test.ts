import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {
    forgetFolderActivity,
    getFolderActivityAtMs,
    parseActivityStore,
    recordFolderActivity,
} from './folder-activity.js';

describe(recordFolderActivity.name, () => {
    it('stamps a folder and reads it back through any spelling of its path', () => {
        const folder = join(homedir(), 'agent-storm-activity-test');
        const before = Date.now();

        recordFolderActivity(`${folder}/./`);

        assert.isAtLeast(getFolderActivityAtMs(folder), before);
        forgetFolderActivity(folder);
    });

    it('reports 0 for a folder nobody has typed in', () => {
        assert.strictEquals(getFolderActivityAtMs('/tmp/agent-storm-never-typed-in'), 0);
    });
});

describe(forgetFolderActivity.name, () => {
    it('drops the stamp so a rebuilt worktree of the same name starts fresh', () => {
        const folder = join(homedir(), 'agent-storm-activity-forget-test');
        recordFolderActivity(folder);

        forgetFolderActivity(folder);

        assert.strictEquals(getFolderActivityAtMs(folder), 0);
    });
});

describe(parseActivityStore.name, () => {
    it('keeps valid stamps and drops malformed ones', () => {
        const parsed = parseActivityStore(
            JSON.stringify({
                '/tmp/good': 1_700_000_000_000,
                '/tmp/string': 'nope',
                '/tmp/zero': 0,
                '/tmp/negative': -5,
            }),
        );

        assert.deepEquals(parsed, {
            '/tmp/good': 1_700_000_000_000,
        });
    });

    it('falls back to an empty store for contents that are not JSON', () => {
        assert.deepEquals(parseActivityStore('{not json'), {});
    });
});
