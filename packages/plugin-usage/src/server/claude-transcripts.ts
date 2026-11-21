import {awaitedFind} from '@augment-vir/common';
import {open, readdir} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {checkValidShape, defineShape, exactShape, nullableShape} from 'object-shape-tester';

const transcriptAssistantShape = defineShape({
    type: exactShape('assistant'),
    timestamp: '',
    message: {
        id: '',
        model: '',
        usage: {
            input_tokens: 0,
            output_tokens: 0,
            cache_read_input_tokens: nullableShape(0),
            cache_creation_input_tokens: nullableShape(0),
            output_tokens_details: nullableShape(
                defineShape({
                    thinking_tokens: nullableShape(0),
                }),
            ),
        },
    },
});

/** What one Claude API response in a transcript spent. */
export type TranscriptUsage = Readonly<{
    messageId: string;
    model: string;
    /** Epoch milliseconds. */
    occurredAt: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    reasoningTokens: number;
}>;

/**
 * The usage of each API response in transcript lines. Claude Code writes a response once per
 * content block, each line with the same message id, so callers must key records by it.
 */
export function parseTranscriptUsage(lines: string): TranscriptUsage[] {
    return lines.split('\n').flatMap((line) => {
        if (!line.includes('"assistant"')) {
            return [];
        }
        try {
            const entry: unknown = JSON.parse(line);
            if (
                !checkValidShape(entry, transcriptAssistantShape, {
                    allowExtraKeys: true,
                }) ||
                /** Claude Code's own notices, such as an API error shown as a reply. */
                entry.message.model === '<synthetic>'
            ) {
                return [];
            }
            const usage = entry.message.usage;
            return [
                {
                    messageId: entry.message.id,
                    model: entry.message.model,
                    occurredAt: Date.parse(entry.timestamp),
                    inputTokens: usage.input_tokens,
                    outputTokens: usage.output_tokens,
                    cacheReadTokens: usage.cache_read_input_tokens || 0,
                    cacheWriteTokens: usage.cache_creation_input_tokens || 0,
                    reasoningTokens: usage.output_tokens_details?.thinking_tokens || 0,
                },
            ];
        } catch {
            return [];
        }
    });
}

function findClaudeConfigDir() {
    return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
}

/** The folder Claude Code keeps the transcripts of sessions started in `cwd` in. */
export function toClaudeProjectDirName(cwd: string) {
    return cwd.replaceAll(/[^a-zA-Z0-9]/g, '-');
}

/**
 * The transcript of a Claude session and of each sub-agent it ran. Empty when Claude hasn't written
 * the session yet. Looks in the project folder for `cwd` first, then in every project folder, since
 * a session can change its cwd.
 */
export async function findSessionTranscripts({
    claudeSessionId,
    cwd,
}: Readonly<{
    claudeSessionId: string;
    cwd: string;
}>) {
    const projectsDir = join(findClaudeConfigDir(), 'projects');
    const transcriptFileName = `${claudeSessionId}.jsonl`;

    async function hasTranscript(projectName: string) {
        const fileNames = await readdir(join(projectsDir, projectName)).catch((): string[] => []);
        return fileNames.includes(transcriptFileName);
    }

    const cwdProjectName = toClaudeProjectDirName(cwd);
    const projectName = (await hasTranscript(cwdProjectName))
        ? cwdProjectName
        : await awaitedFind(
              await readdir(projectsDir).catch((): string[] => []),
              async (name) => await hasTranscript(name),
          );
    if (!projectName) {
        return [];
    }
    const projectDir = join(projectsDir, projectName);
    const subagentsDir = join(projectDir, claudeSessionId, 'subagents');
    const subagentFileNames = await readdir(subagentsDir).catch((): string[] => []);
    return [
        join(projectDir, transcriptFileName),
        ...subagentFileNames
            .filter((fileName) => fileName.endsWith('.jsonl'))
            .map((fileName) => join(subagentsDir, fileName)),
    ];
}

/** Caps one read, so a long transcript seen for the first time is read over several passes. */
const maxReadBytes = 16 * 1024 * 1024;

/**
 * The complete lines written to `filePath` past `byteOffset`, and the offset after them. A line
 * still being written is left for the next read. Starts over when the file shrank, which means it
 * was replaced.
 */
export async function readNewLines({
    filePath,
    byteOffset,
}: Readonly<{
    filePath: string;
    byteOffset: number;
}>) {
    const file = await open(filePath, 'r');
    try {
        const {size} = await file.stat();
        const start = size < byteOffset ? 0 : byteOffset;
        const buffer = Buffer.alloc(Math.min(size - start, maxReadBytes));
        await file.read(buffer, 0, buffer.length, start);
        const lastNewline = buffer.lastIndexOf('\n');
        if (lastNewline < 0) {
            return {
                lines: '',
                /** A single line longer than a whole read can't be parsed, so it's skipped. */
                nextOffset: buffer.length === maxReadBytes ? start + maxReadBytes : start,
            };
        }
        return {
            lines: buffer.subarray(0, lastNewline).toString('utf8'),
            nextOffset: start + lastNewline + 1,
        };
    } finally {
        await file.close();
    }
}
