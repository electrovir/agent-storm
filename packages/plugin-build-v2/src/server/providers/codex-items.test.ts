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
