import {assert, waitUntil} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AiProvider, ComposerCommandKind, ComposerCommandSource} from '../build-api.js';
import {openListingCache} from './listing-cache.js';

describe(openListingCache.name, () => {
    it('reads back what an earlier process saved', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'listing-cache-test-'));
        const commands = [
            {
                name: 'review',
                description: 'Reviews the diff.',
                argumentHint: '',
                kind: ComposerCommandKind.Command,
                source: ComposerCommandSource.Repo,
            },
        ];
        try {
            const first = await openListingCache(dir);
            assert.isUndefined(first.readCommands('claude:/repo'));
            first.saveModels(AiProvider.Claude, []);
            first.saveCommands('claude:/repo', commands);
            await waitUntil.deepEquals(commands, async () => {
                return (await openListingCache(dir)).readCommands('claude:/repo');
            });
            assert.deepEquals((await openListingCache(dir)).readModels(AiProvider.Claude), []);
        } finally {
            await rm(dir, {
                recursive: true,
                force: true,
            });
        }
    });
});
