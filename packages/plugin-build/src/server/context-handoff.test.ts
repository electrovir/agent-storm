import {assert} from '@augment-vir/assert';
import {createArray} from '@augment-vir/common';
import {describe, it} from '@augment-vir/test';
import {ThreadItemKind} from '../build-api.js';
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

    it('counts the separators between messages toward the history limit', () => {
        const messageCount: number = 3200;
        const handoff = buildContextHandoff({
            items: createArray(messageCount, (index) => {
                return {
                    kind: ThreadItemKind.UserMessage,
                    text: `Earlier message ${index}.`,
                };
            }),
            text: 'Current request.',
        });
        const history = handoff.slice(
            handoff.indexOf('[User]\n'),
            handoff.lastIndexOf('\n\nUser message:\n'),
        );

        assert.isAtMost(history.length, 64_000);
        assert.isTrue(history.endsWith('Earlier message 3199.'));
    });

    it('keeps the end of the latest message when it fills the history limit', () => {
        const handoff = buildContextHandoff({
            items: [
                {
                    kind: ThreadItemKind.UserMessage,
                    text: 'Earlier request.',
                },
                {
                    kind: ThreadItemKind.AssistantMessage,
                    text: `Previous details. ${'x'.repeat(64_000)} Keep the recent requirement.`,
                },
            ],
            text: 'Current request.',
        });

        assert.isTrue(handoff.includes('[Assistant]\n'));
        assert.isTrue(
            handoff.endsWith('Keep the recent requirement.\n\nUser message:\nCurrent request.'),
        );
        assert.isFalse(handoff.includes('Earlier request.'));
    });
});
