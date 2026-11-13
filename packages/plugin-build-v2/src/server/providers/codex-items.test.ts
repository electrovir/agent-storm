import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {ThreadItemKind, ThreadItemStatus} from '../../build-v2-api.js';
import {describeCodexItem} from './codex-items.js';

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
