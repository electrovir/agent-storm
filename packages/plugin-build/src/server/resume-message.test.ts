import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {buildResumeMessage} from './resume-message.js';

describe(buildResumeMessage.name, () => {
    it('does not nest an earlier resume message', () => {
        const firstResume = buildResumeMessage([
            'first\n\nmessage',
            'second',
        ]);

        assert.strictEquals(
            buildResumeMessage([
                buildResumeMessage([
                    firstResume,
                    'third',
                ]),
            ]),
            buildResumeMessage([
                'first\n\nmessage',
                'second',
                'third',
            ]),
        );
    });

    it('drops an earlier resume message that quoted nothing', () => {
        assert.strictEquals(buildResumeMessage([buildResumeMessage([])]), buildResumeMessage([]));
    });
});
