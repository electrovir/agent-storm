// cspell:words dont
import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {createAiCommand, createAiText} from './ai-command.js';
import {BotAiEffort, BotAiProvider} from './bot-ai.js';

describe(createAiText.name, () => {
    it('invokes a skill the way each provider expects', () => {
        assert.deepEquals(
            [
                BotAiProvider.Claude,
                BotAiProvider.Codex,
            ].map((provider) => {
                return createAiText({
                    execute: {
                        skill: 'triage once',
                    },
                    provider,
                });
            }),
            [
                '/triage once',
                '$triage once',
            ],
        );
    });
});

describe(createAiCommand.name, () => {
    it('ends the tool lists before the prompt and quotes every argument', () => {
        assert.strictEquals(
            createAiCommand({
                execute: {
                    prompt: "Fix the bot's tests.",
                    allowedTools: [
                        'Read',
                        'Edit',
                    ],
                },
                ai: {
                    provider: BotAiProvider.Claude,
                    model: 'claude-haiku-5',
                    effort: BotAiEffort.Low,
                },
            }),
            String.raw`'claude' '--print' '--model' 'claude-haiku-5' '--effort' 'low' '--permission-mode' 'dontAsk' '--allowedTools' 'Read' 'Edit' '--' 'Fix the bot'\''s tests.'`,
        );
    });
    it('passes effort to Codex as config', () => {
        assert.strictEquals(
            createAiCommand({
                execute: {
                    skill: 'triage',
                },
                ai: {
                    provider: BotAiProvider.Codex,
                    model: 'gpt-6-luna',
                    effort: BotAiEffort.Max,
                },
            }),
            `'codex' 'exec' '--model' 'gpt-6-luna' '--config' 'model_reasoning_effort="max"' '$triage'`,
        );
    });
    it('rejects tool lists for Codex', () => {
        assert.throws(() => {
            return createAiCommand({
                execute: {
                    prompt: 'hi',
                    allowedTools: [
                        'Read',
                    ],
                },
                ai: {
                    provider: BotAiProvider.Codex,
                    model: 'gpt-6-luna',
                },
            });
        });
    });
});
