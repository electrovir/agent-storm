// cspell:word subkeys
import {type SessionStore, type SessionStoreEntry} from '@anthropic-ai/claude-agent-sdk';
import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {mkdtemp, readFile, realpath, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createClaudeProjectKey, restoreClaudeTranscript} from './claude-transcript.js';

function createStore(transcripts: Readonly<Record<string, SessionStoreEntry[]>>): SessionStore {
    return {
        append() {
            return Promise.resolve();
        },
        load({subpath}) {
            return Promise.resolve(transcripts[subpath || ''] ?? null);
        },
        listSubkeys() {
            return Promise.resolve(Object.keys(transcripts).filter(Boolean));
        },
    };
}

describe(createClaudeProjectKey.name, () => {
    it('replaces every non-alphanumeric character', () => {
        assert.strictEquals(
            createClaudeProjectKey('/Users/someone/repos/my.app'),
            '-Users-someone-repos-my-app',
        );
    });
    it('shortens long paths with a hash', () => {
        const key = createClaudeProjectKey(`/${'a'.repeat(300)}`);
        assert.isTrue(/^-a{199}-[a-z0-9]+$/.test(key));
    });
});

describe(restoreClaudeTranscript.name, () => {
    it('writes the session and sub-agent transcripts', async () => {
        const root = await realpath(await mkdtemp(join(tmpdir(), 'claude-transcript-test-')));
        try {
            const projectDir = join(root, 'config', 'projects', createClaudeProjectKey(root));
            await restoreClaudeTranscript({
                sessionStore: createStore({
                    '': [
                        {
                            type: 'user',
                            uuid: 'first',
                        },
                        {
                            type: 'assistant',
                            uuid: 'second',
                        },
                    ],
                    'subagents/agent-1': [
                        {
                            type: 'user',
                            uuid: 'third',
                        },
                    ],
                }),
                sessionId: 'session-1',
                cwd: root,
                configDir: join(root, 'config'),
            });
            assert.deepEquals(
                await Promise.all([
                    readFile(join(projectDir, 'session-1.jsonl'), 'utf8'),
                    readFile(join(projectDir, 'session-1', 'subagents', 'agent-1.jsonl'), 'utf8'),
                ]),
                [
                    '{"type":"user","uuid":"first"}\n{"type":"assistant","uuid":"second"}\n',
                    '{"type":"user","uuid":"third"}\n',
                ],
            );
        } finally {
            await rm(root, {
                recursive: true,
                force: true,
            });
        }
    });
});
