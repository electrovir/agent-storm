import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {AiProvider} from '../build-api.js';
import {parsePluginLaunch, serializePluginLaunch} from './plugin-launch.js';

describe(parsePluginLaunch.name, () => {
    it('reads back a serialized launch', () => {
        const launch = {
            pluginId: 'bots',
            ownerId: 'bot-1',
            provider: AiProvider.Codex,
            isUnattended: true,
            env: {
                BOT_RUN: '1',
            },
        };
        assert.deepEquals(parsePluginLaunch(serializePluginLaunch(launch)), launch);
    });
    it('reads a launch saved without isUnattended as attended', () => {
        assert.isFalse(
            parsePluginLaunch(
                JSON.stringify({
                    pluginId: 'bots',
                    ownerId: 'bot-1',
                    provider: AiProvider.Codex,
                    env: [],
                }),
            ).isUnattended,
        );
    });
    it('rejects a launch missing its owner', () => {
        assert.throws(() => {
            parsePluginLaunch(
                JSON.stringify({
                    pluginId: 'bots',
                    provider: AiProvider.Codex,
                    env: [],
                }),
            );
        });
    });
});
