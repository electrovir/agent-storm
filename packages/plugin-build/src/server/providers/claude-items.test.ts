import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {ThreadItemKind, ThreadItemStatus} from '../../build-api.js';
import {
    completeClaudeToolItem,
    describeClaudeToolUse,
    readClaudeMessageUsage,
    readClaudeToolResultText,
} from './claude-items.js';

describe(describeClaudeToolUse.name, () => {
    it('shows an edit as removed and added lines', () => {
        assert.deepEquals(
            describeClaudeToolUse({
                name: 'Edit',
                input: {
                    file_path: '/repo/a.ts',
                    old_string: 'one\ntwo',
                    new_string: 'three',
                },
            }),
            {
                kind: ThreadItemKind.FileChange,
                title: '/repo/a.ts',
                text: '-one\n-two\n+three',
            },
        );
    });

    it('shows an unknown tool as its input', () => {
        assert.deepEquals(
            describeClaudeToolUse({
                name: 'mcp__docs__search',
                input: {
                    query: 'x',
                },
            }),
            {
                kind: ThreadItemKind.ToolCall,
                title: 'mcp__docs__search',
                text: JSON.stringify(
                    {
                        query: 'x',
                    },
                    undefined,
                    4,
                ),
            },
        );
    });
});

describe(readClaudeToolResultText.name, () => {
    it('joins text blocks and skips the rest', () => {
        assert.strictEquals(
            readClaudeToolResultText([
                {
                    type: 'text',
                    text: 'first',
                },
                {
                    type: 'image',
                },
                {
                    type: 'text',
                    text: 'second',
                },
            ]),
            'first\nsecond',
        );
    });
});

describe(completeClaudeToolItem.name, () => {
    const command = {
        kind: ThreadItemKind.Command,
        title: 'npm test',
        text: '',
    };

    it('gives a command its output', () => {
        assert.deepEquals(
            completeClaudeToolItem({
                tool: command,
                output: 'passed',
                isError: false,
                isDeclined: false,
            }),
            {
                ...command,
                status: ThreadItemStatus.Completed,
                text: 'passed',
            },
        );
    });

    it('marks a declined call declined rather than failed', () => {
        assert.strictEquals(
            completeClaudeToolItem({
                tool: command,
                output: 'The user declined this.',
                isError: true,
                isDeclined: true,
            }).status,
            ThreadItemStatus.Declined,
        );
    });
});

describe(readClaudeMessageUsage.name, () => {
    it('keys usage by the API message', () => {
        assert.deepEquals(
            readClaudeMessageUsage({
                id: 'msg_1',
                model: 'claude-opus-4-1',
                usage: {
                    input_tokens: 10,
                    output_tokens: 20,
                    cache_read_input_tokens: 300,
                    cache_creation_input_tokens: null,
                },
            }),
            {
                dedupeKey: 'claude-message:msg_1',
                model: 'claude-opus-4-1',
                inputTokens: 10,
                outputTokens: 20,
                cacheReadTokens: 300,
                cacheWriteTokens: 0,
            },
        );
    });

    it("skips Claude Code's own notices", () => {
        assert.isUndefined(
            readClaudeMessageUsage({
                id: 'msg_2',
                model: '<synthetic>',
                usage: {
                    input_tokens: 0,
                    output_tokens: 0,
                },
            }),
        );
    });
});
