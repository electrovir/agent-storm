import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {
    resolveStandalonePolicy,
    StandaloneQuestion,
    StandaloneThread,
} from './standalone-policy.js';

describe(resolveStandalonePolicy.name, () => {
    it('takes each field from the first policy that sets it', () => {
        assert.deepEquals(
            resolveStandalonePolicy(
                {
                    question: StandaloneQuestion.Fail,
                },
                undefined,
                {
                    question: StandaloneQuestion.FirstOption,
                    thread: StandaloneThread.RunHeadless,
                },
            ),
            {
                question: StandaloneQuestion.Fail,
                thread: StandaloneThread.RunHeadless,
            },
        );
    });
    it('ignores Agent Storm calls when nothing is set', () => {
        assert.deepEquals(resolveStandalonePolicy(undefined), {
            question: StandaloneQuestion.Ignore,
            thread: StandaloneThread.Ignore,
        });
    });
});
