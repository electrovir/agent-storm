import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {createStandaloneHost} from './agent-storm-client.js';
import {BotAiProvider} from './bot-ai.js';
import {StandaloneQuestion, StandaloneThread} from './standalone-policy.js';

function createHost(question: StandaloneQuestion) {
    return createStandaloneHost({
        cwd: process.cwd(),
        policy: {
            question,
            thread: StandaloneThread.Fail,
        },
        isTerminal: false,
    });
}

const question = {
    question: 'Merge it?',
    options: [
        'Yes',
        'No',
    ],
};

describe(createStandaloneHost.name, () => {
    it('answers questions by its policy', async () => {
        assert.deepEquals(
            await Promise.all(
                [
                    StandaloneQuestion.Ignore,
                    StandaloneQuestion.FirstOption,
                    StandaloneQuestion.Terminal,
                ].map(async (policy) => {
                    return await createHost(policy).askQuestion(question);
                }),
            ),
            [
                undefined,
                'Yes',
                'Yes',
            ],
        );
    });
    it('throws for a question or thread when its policy is Fail', async () => {
        const host = createHost(StandaloneQuestion.Fail);
        await assert.throws(host.askQuestion(question));
        await assert.throws(
            host.startThread({
                prompt: 'Do it.',
                ai: {
                    provider: BotAiProvider.Claude,
                    model: 'claude-haiku-5',
                },
                env: {},
            }),
        );
    });
});
