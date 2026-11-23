import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {ThreadItemKind, ThreadItemStatus} from '../../build-v2-api.js';
import {describeCodexItem, readCodexTokenUsage} from './codex-items.js';

describe(describeCodexItem.name, () => {
    it('takes a command item and its status', () => {
        assert.deepEquals(
            describeCodexItem({
                item: {
                    type: 'commandExecution',
                    id: 'item-1',
                    command: 'ls',
                    cwd: '/repo',
                    status: 'failed',
                    aggregatedOutput: 'no such file',
                    exitCode: 1,
                },
                isCompleted: true,
            }),
            {
                providerItemId: 'item-1',
                kind: ThreadItemKind.Command,
                status: ThreadItemStatus.Failed,
                title: 'ls',
                text: 'no such file',
            },
        );
    });

    it('marks an item without a status by whether it completed', () => {
        assert.deepEquals(
            describeCodexItem({
                item: {
                    type: 'agentMessage',
                    id: 'item-2',
                    text: 'Hi',
                    phase: null,
                },
                isCompleted: false,
            }),
            {
                providerItemId: 'item-2',
                kind: ThreadItemKind.AssistantMessage,
                status: ThreadItemStatus.InProgress,
                title: '',
                text: 'Hi',
            },
        );
    });

    it('shows a viewed image by its path', () => {
        assert.deepEquals(
            describeCodexItem({
                item: {
                    type: 'imageView',
                    id: 'item-4',
                    path: '/tmp/chart.png',
                },
                isCompleted: true,
            }),
            {
                providerItemId: 'item-4',
                kind: ThreadItemKind.ToolCall,
                status: ThreadItemStatus.Completed,
                title: 'View image',
                text: '/tmp/chart.png',
                imagePaths: [
                    '/tmp/chart.png',
                ],
            },
        );
    });

    it("doesn't show the user's own upload again", () => {
        assert.deepEquals(
            describeCodexItem({
                item: {
                    type: 'imageView',
                    id: 'item-4',
                    path: '/var/folders/xy/T/agent-storm-plugins/build-v2/1763500000000-a12345678901234567890123-shot.png',
                },
                isCompleted: true,
            })?.imagePaths,
            [],
        );
    });

    it("moves an MCP result's images out of its text", () => {
        assert.deepEquals(
            describeCodexItem({
                item: {
                    type: 'mcpToolCall',
                    id: 'item-5',
                    server: 'figma',
                    tool: 'get_screenshot',
                    status: 'completed',
                    arguments: {},
                    result: {
                        content: [
                            {
                                type: 'image',
                                data: 'iVBORw0K',
                                mimeType: 'image/png',
                            },
                        ],
                    },
                    error: null,
                },
                isCompleted: true,
            }),
            {
                providerItemId: 'item-5',
                kind: ThreadItemKind.ToolCall,
                status: ThreadItemStatus.Completed,
                title: 'figma.get_screenshot',
                text: [
                    '{}',
                    JSON.stringify(
                        {
                            content: [
                                {
                                    type: 'image',
                                    mimeType: 'image/png',
                                },
                            ],
                        },
                        undefined,
                        4,
                    ),
                ].join('\n\n'),
                inlineImages: [
                    {
                        mimeType: 'image/png',
                        dataBase64: 'iVBORw0K',
                    },
                ],
            },
        );
    });

    it('leaves out user messages and malformed items', () => {
        assert.deepEquals(
            [
                {
                    type: 'userMessage',
                    id: 'item-3',
                    content: [],
                },
                {
                    type: 'agentMessage',
                    id: 'item-4',
                },
            ].map((item) => {
                return describeCodexItem({
                    item,
                    isCompleted: true,
                });
            }),
            [
                undefined,
                undefined,
            ],
        );
    });
});

describe(readCodexTokenUsage.name, () => {
    function createBreakdown({
        inputTokens,
        totalTokens,
    }: Readonly<{
        inputTokens: number;
        totalTokens: number;
    }>) {
        return {
            inputTokens,
            cachedInputTokens: 100,
            outputTokens: 30,
            reasoningOutputTokens: 5,
            totalTokens,
        };
    }

    it('logs the last response, not the running total', () => {
        assert.deepEquals(
            readCodexTokenUsage({
                params: {
                    threadId: 'thread-1',
                    turnId: 'turn-1',
                    tokenUsage: {
                        last: createBreakdown({
                            inputTokens: 150,
                            totalTokens: 180,
                        }),
                        total: createBreakdown({
                            inputTokens: 900,
                            totalTokens: 1200,
                        }),
                        modelContextWindow: null,
                    },
                },
                model: 'gpt-5-codex',
            }),
            {
                dedupeKey: 'codex-usage:thread-1:turn-1:1200',
                model: 'gpt-5-codex',
                inputTokens: 50,
                outputTokens: 30,
                cacheReadTokens: 100,
                cacheWriteTokens: 0,
                reasoningTokens: 5,
            },
        );
    });

    it('ignores params in an unknown format', () => {
        assert.isUndefined(
            readCodexTokenUsage({
                params: {
                    threadId: 'thread-1',
                },
                model: 'gpt-5-codex',
            }),
        );
    });
});
