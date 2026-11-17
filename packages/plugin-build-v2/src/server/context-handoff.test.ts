import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {ThreadItemKind} from '../build-v2-api.js';
import {buildContextHandoff} from './context-handoff.js';

describe(buildContextHandoff.name, () => {
    it('labels earlier messages and leaves out other items', () => {
        const handoff = buildContextHandoff({
            items: [
                {
                    kind: ThreadItemKind.UserMessage,
                    text: 'Fix the build.',
                },
                {
                    kind: ThreadItemKind.Command,
                    text: 'npm run compile',
                },
                {
                    kind: ThreadItemKind.AssistantMessage,
                    text: 'Fixed the import.',
                },
            ],
            text: 'Now add a test.',
        });
        assert.isTrue(
            handoff.endsWith(
                '[User]\nFix the build.\n\n[Assistant]\nFixed the import.\n\nUser message:\nNow add a test.',
            ),
        );
        assert.isFalse(handoff.includes('npm run compile'));
    });

    it('returns the text alone without earlier messages', () => {
        assert.strictEquals(
            buildContextHandoff({
                items: [],
                text: 'Hello.',
            }),
            'Hello.',
        );
    });

    it('leaves out the oldest messages past the limit', () => {
        const handoff = buildContextHandoff({
            items: [
                {
                    kind: ThreadItemKind.UserMessage,
                    text: `old ${'a'.repeat(40_000)}`,
                },
                {
                    kind: ThreadItemKind.AssistantMessage,
                    text: `new ${'b'.repeat(40_000)}`,
                },
            ],
            text: 'Next.',
        });
        assert.isTrue(handoff.includes('1 older messages are left out.'));
        assert.isFalse(handoff.includes('old '));
        assert.isTrue(handoff.includes('new '));
    });
});
