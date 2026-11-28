import {assert, check} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {BotAiProvider} from './bot-ai.js';
import {assertBotDefinition, defineBot} from './bot-definition.js';

const baseBot = {
    description: 'Says hi.',
    interval: {
        minutes: 5,
    },
    ai: {
        provider: BotAiProvider.Claude,
        model: 'claude-haiku-5',
    },
    execute: {
        prompt: 'Say hi.',
    },
};

describe(defineBot.name, () => {
    it('returns the bot unchanged', () => {
        assert.strictEquals(defineBot(baseBot), baseBot);
    });
    it("leaves an invalid bot for the CLI to reject, so the config's other bots still load", () => {
        const invalidBot = {
            ...baseBot,
            interval: {
                minutes: 0,
            },
        };
        assert.strictEquals(defineBot(invalidBot), invalidBot);
    });
});

describe(assertBotDefinition.name, () => {
    it('accepts a valid bot', () => {
        assert.isFalse(
            check.throws(() => {
                assertBotDefinition(baseBot);
            }),
        );
    });
    it('rejects a zero interval', () => {
        assert.throws(() => {
            assertBotDefinition({
                ...baseBot,
                interval: {
                    minutes: 0,
                },
            });
        });
    });
    it('rejects an execute object with neither a prompt nor a skill', () => {
        assert.throws(() => {
            assertBotDefinition({
                ...baseBot,
                execute: {},
            });
        });
    });
});
