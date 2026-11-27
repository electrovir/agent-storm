// cspell:words sidechain

import {SplitDirection} from '@agent-storm/common';
import {type PaneGroupState} from '@agent-storm/core/server';
import {type SessionStoreEntry} from '@anthropic-ai/claude-agent-sdk';
import {assert} from '@augment-vir/assert';
import {getObjectTypedKeys, removeDuplicates, selectFrom} from '@augment-vir/common';
import {describe, it} from '@augment-vir/test';
import {aiChatPaneId, ThreadItemKind} from '../build-api.js';
import {buildItems, replaceAiTabs} from './build-v1-conversion.js';

const timestamp = '2026-01-02T03:04:05.000Z';

describe(buildItems.name, () => {
    it('turns a transcript into thread items, merging split responses and skipping noise', () => {
        const entries: SessionStoreEntry[] = [
            {
                type: 'user',
                timestamp,
                message: {
                    content: 'Fix the failing build please',
                },
            },
            {
                type: 'assistant',
                timestamp,
                message: {
                    id: 'message-1',
                    content: [
                        {
                            type: 'thinking',
                            thinking: 'Looking at the build.',
                        },
                        {
                            type: 'text',
                            text: 'On it.',
                        },
                    ],
                },
            },
            {
                type: 'assistant',
                timestamp,
                message: {
                    id: 'message-1',
                    content: [
                        {
                            type: 'tool_use',
                            id: 'tool-1',
                            name: 'Bash',
                            input: {
                                command: 'npm test',
                            },
                        },
                    ],
                },
            },
            {
                type: 'user',
                timestamp,
                message: {
                    content: [
                        {
                            type: 'tool_result',
                            tool_use_id: 'tool-1',
                            content: 'all passed',
                        },
                    ],
                },
            },
            {
                type: 'user',
                timestamp,
                isSidechain: true,
                message: {
                    content: 'A sub-agent prompt',
                },
            },
            {
                type: 'user',
                timestamp,
                message: {
                    content: '[Request interrupted by user]',
                },
            },
            {
                type: 'user',
                timestamp,
                message: {
                    content: '<command-name>compact</command-name><command-args>now</command-args>',
                },
            },
        ];
        const items = buildItems(entries);

        assert.deepEquals(
            items.map((item) => {
                return selectFrom(item, {
                    kind: true,
                    text: true,
                    providerItemId: true,
                });
            }),
            [
                {
                    kind: ThreadItemKind.UserMessage,
                    text: 'Fix the failing build please',
                    providerItemId: null,
                },
                {
                    kind: ThreadItemKind.Reasoning,
                    text: 'Looking at the build.',
                    providerItemId: 'message-1:0',
                },
                {
                    kind: ThreadItemKind.AssistantMessage,
                    text: 'On it.',
                    providerItemId: 'message-1:1',
                },
                {
                    kind: ThreadItemKind.Command,
                    text: 'all passed',
                    providerItemId: 'tool-1',
                },
                {
                    kind: ThreadItemKind.UserMessage,
                    text: '/compact now',
                    providerItemId: null,
                },
            ],
        );
        assert.isLengthExactly(removeDuplicates(items.map((item) => item.turnId)), 2);
    });
});

function createTab({id, kind}: Readonly<{id: string; kind: string}>) {
    return {
        id,
        kind,
        name: undefined,
        state: undefined,
    };
}

function createState(groups: Record<string, string[]>): PaneGroupState {
    return {
        tabLayout: {
            tabs: {
                shell: createTab({
                    id: 'shell',
                    kind: 'shell',
                }),
                'ai-1': createTab({
                    id: 'ai-1',
                    kind: 'ai',
                }),
                'ai-2': createTab({
                    id: 'ai-2',
                    kind: 'ai',
                }),
                notes: createTab({
                    id: 'notes',
                    kind: 'viewer',
                }),
            },
            groups: {
                first: {
                    tabIds: groups.first || [],
                },
                second: {
                    tabIds: groups.second || [],
                },
            },
            splits: {
                root: {
                    direction: SplitDirection.Row,
                    childIds: [
                        'first',
                        'second',
                    ],
                    sizes: [
                        0.5,
                        0.5,
                    ],
                },
            },
            rootId: 'root',
            nextNodeId: 3,
        },
        tabSelection: {
            activeGroupId: 'second',
            activeTabIdByGroup: {
                first: 'ai-2',
                second: 'notes',
            },
        },
    };
}

describe(replaceAiTabs.name, () => {
    it('puts one chat tab where the first AI tab was and selects it', () => {
        const chatTabId = `${aiChatPaneId}:thread-1`;
        const result = replaceAiTabs({
            state: createState({
                first: [
                    'shell',
                    'ai-1',
                    'ai-2',
                ],
                second: [
                    'notes',
                ],
            }),
            threadId: 'thread-1',
        });

        assert.deepEquals(
            {
                tabIds: getObjectTypedKeys(result?.tabLayout.tabs || {}),
                groups: result?.tabLayout.groups,
                tabSelection: result?.tabSelection,
            },
            {
                tabIds: [
                    'shell',
                    'notes',
                    chatTabId,
                ],
                groups: {
                    first: {
                        tabIds: [
                            'shell',
                            chatTabId,
                        ],
                    },
                    second: {
                        tabIds: [
                            'notes',
                        ],
                    },
                },
                tabSelection: {
                    activeGroupId: 'first',
                    activeTabIdByGroup: {
                        first: chatTabId,
                        second: 'notes',
                    },
                },
            },
        );
    });

    it('gives up when removing the AI tabs would empty a group', () => {
        assert.isUndefined(
            replaceAiTabs({
                state: createState({
                    first: [
                        'ai-1',
                    ],
                    second: [
                        'ai-2',
                    ],
                }),
                threadId: 'thread-1',
            }),
        );
    });
});
