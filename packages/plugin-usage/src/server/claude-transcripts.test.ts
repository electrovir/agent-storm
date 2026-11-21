import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {appendFile, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parseTranscriptUsage, readNewLines, toClaudeProjectDirName} from './claude-transcripts.js';

function createAssistantLine({id, model}: Readonly<{id: string; model: string}>) {
    return JSON.stringify({
        type: 'assistant',
        timestamp: '2026-11-19T12:00:00.000Z',
        message: {
            id,
            model,
            usage: {
                input_tokens: 2,
                output_tokens: 870,
                cache_read_input_tokens: 162_700,
                cache_creation_input_tokens: 1916,
                output_tokens_details: {
                    thinking_tokens: 258,
                },
            },
        },
    });
}

describe(parseTranscriptUsage.name, () => {
    it('reads assistant usage and skips other lines', () => {
        assert.deepEquals(
            parseTranscriptUsage(
                [
                    JSON.stringify({
                        type: 'user',
                    }),
                    createAssistantLine({
                        id: 'msg_1',
                        model: 'claude-opus-5',
                    }),
                    createAssistantLine({
                        id: 'msg_2',
                        model: '<synthetic>',
                    }),
                    '{"type":"assistant", not json',
                ].join('\n'),
            ),
            [
                {
                    messageId: 'msg_1',
                    model: 'claude-opus-5',
                    occurredAt: Date.parse('2026-11-19T12:00:00.000Z'),
                    inputTokens: 2,
                    outputTokens: 870,
                    cacheReadTokens: 162_700,
                    cacheWriteTokens: 1916,
                    reasoningTokens: 258,
                },
            ],
        );
    });
});

describe(readNewLines.name, () => {
    it('leaves a partly written line for the next read', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'usage-transcript-'));
        const filePath = join(dir, 'session.jsonl');
        try {
            await writeFile(filePath, 'first\nsecond\nla');
            const firstRead = await readNewLines({
                filePath,
                byteOffset: 0,
            });
            await appendFile(filePath, 'st\n');
            const secondRead = await readNewLines({
                filePath,
                byteOffset: firstRead.nextOffset,
            });
            assert.deepEquals(
                [
                    firstRead.lines,
                    secondRead.lines,
                ],
                [
                    'first\nsecond',
                    'last',
                ],
            );
        } finally {
            await rm(dir, {
                recursive: true,
                force: true,
            });
        }
    });

    it('starts over when the file shrank', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'usage-transcript-'));
        const filePath = join(dir, 'session.jsonl');
        try {
            await writeFile(filePath, 'new\n');
            assert.deepEquals(
                await readNewLines({
                    filePath,
                    byteOffset: 1000,
                }),
                {
                    lines: 'new',
                    nextOffset: 4,
                },
            );
        } finally {
            await rm(dir, {
                recursive: true,
                force: true,
            });
        }
    });
});

describe(toClaudeProjectDirName.name, () => {
    it('replaces every character but letters and digits', () => {
        assert.strictEquals(
            toClaudeProjectDirName('/Users/someone/.agent-storm/my_repo'),
            '-Users-someone--agent-storm-my-repo',
        );
    });
});
