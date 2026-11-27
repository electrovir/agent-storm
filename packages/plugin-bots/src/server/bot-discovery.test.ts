import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {createBotId, createRepoId} from './bot-discovery.js';

describe(createBotId.name, () => {
    it('keeps a bot id across calls and tells bots and repos apart', () => {
        const repoPath = '/repos/example';
        const botId = createBotId({
            repoPath,
            name: 'watch-slack',
        });

        assert.deepEquals(
            [
                createBotId({
                    repoPath,
                    name: 'watch-slack',
                }),
                botId ===
                    createBotId({
                        repoPath,
                        name: 'release',
                    }),
                botId ===
                    createBotId({
                        repoPath: '/repos/other',
                        name: 'watch-slack',
                    }),
                botId === createRepoId(repoPath),
            ],
            [
                botId,
                false,
                false,
                false,
            ],
        );
    });
});
