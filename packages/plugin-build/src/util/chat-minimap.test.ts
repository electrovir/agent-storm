import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {ThreadItemKind, ThreadItemStatus, type ThreadItem} from '../build-api.js';
import {buildMinimapTurns, getMinimapViewport} from './chat-minimap.js';

function createItem(overrides: Readonly<Partial<ThreadItem>>): ThreadItem {
    return {
        id: 'item',
        threadId: 'thread',
        turnId: 'turn',
        kind: ThreadItemKind.Command,
        status: ThreadItemStatus.Completed,
        title: '',
        text: '',
        imagePaths: [],
        order: 0,
        createdAt: 0,
        updatedAt: 0,
        ...overrides,
    };
}

describe(buildMinimapTurns.name, () => {
    it('pairs each user message with its last reply', () => {
        assert.deepEquals(
            buildMinimapTurns([
                createItem({
                    id: 'first',
                    kind: ThreadItemKind.UserMessage,
                    text: 'fix the build',
                }),
                createItem({
                    kind: ThreadItemKind.AssistantMessage,
                    text: 'Looking into it.',
                }),
                createItem({
                    kind: ThreadItemKind.Command,
                    text: 'npm run compile',
                }),
                createItem({
                    kind: ThreadItemKind.AssistantMessage,
                    text: 'The build passes now.',
                }),
                createItem({
                    id: 'second',
                    kind: ThreadItemKind.UserMessage,
                    text: 'thanks',
                }),
            ]),
            [
                {
                    id: 'first',
                    userText: 'fix the build',
                    replyText: 'The build passes now.',
                },
                {
                    id: 'second',
                    userText: 'thanks',
                    replyText: '',
                },
            ],
        );
    });
    it('drops attachment paths and ignores items before the first user message', () => {
        assert.deepEquals(
            buildMinimapTurns([
                createItem({
                    kind: ThreadItemKind.AssistantMessage,
                    text: 'Moved to a worktree.',
                }),
                createItem({
                    id: 'only',
                    kind: ThreadItemKind.UserMessage,
                    text: [
                        'see this',
                        '/var/folders/xy/T/agent-storm-plugins/build/1763500000000-a12345678901234567890123-shot.png',
                    ].join('\n'),
                }),
            ]),
            [
                {
                    id: 'only',
                    userText: 'see this',
                    replyText: '',
                },
            ],
        );
    });
});

function createTurnEntry(turnId: string, top: number) {
    return {
        dataset: {
            turnId,
        },
        getBoundingClientRect() {
            return {
                top,
            };
        },
    };
}

describe(getMinimapViewport.name, () => {
    it('highlights a partly visible turn and picks the turn at the jump offset', () => {
        assert.deepEquals(
            getMinimapViewport({
                entries: [
                    createTurnEntry('first', 0),
                    createTurnEntry('second', 100),
                    createTurnEntry('third', 210),
                ],
                view: {
                    top: 90,
                    bottom: 210,
                },
                contentBottom: 240,
                jumpOffset: 24,
            }),
            {
                inViewIds: [
                    'first',
                    'second',
                ],
                currentId: 'second',
                isAtEnd: false,
            },
        );
    });

    it('drops the final turn when the view starts at the end of the content', () => {
        assert.deepEquals(
            getMinimapViewport({
                entries: [
                    createTurnEntry('last', 210),
                ],
                view: {
                    top: 240,
                    bottom: 260,
                },
                contentBottom: 240,
                jumpOffset: 24,
            }),
            {
                inViewIds: [],
                currentId: undefined,
                isAtEnd: true,
            },
        );
    });
});
