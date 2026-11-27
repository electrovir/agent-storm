import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {BotAiProvider} from './bot-ai.js';
import {defineBot} from './bot-definition.js';

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
    it('returns a valid bot unchanged', () => {
        assert.strictEquals(defineBot(baseBot), baseBot);
    });
    it('rejects a zero interval', () => {
        assert.throws(() => {
            return defineBot({
                ...baseBot,
                interval: {
                    minutes: 0,
                },
            });
        });
    });
    it('rejects an execute object with neither a prompt nor a skill', () => {
        assert.throws(() => {
            return defineBot({
                ...baseBot,
                execute: {} as {
                    prompt: string;
                },
            });
        });
    });
});
