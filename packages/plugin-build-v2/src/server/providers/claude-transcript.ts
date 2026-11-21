// cspell:word subkeys
import {type SessionStore} from '@anthropic-ai/claude-agent-sdk';
import {createArray} from '@augment-vir/common';
import {mkdir, realpath, writeFile} from 'node:fs/promises';
import {dirname, join, relative} from 'node:path';

/**
 * The folder name, inside Claude Code's `projects` folder, that holds the transcripts of sessions
 * run in `path`. Matches Claude Code's own naming, including the hash it appends to long paths.
 */
export function createClaudeProjectKey(path: string) {
    const key = path.normalize('NFC').replaceAll(/[^a-zA-Z0-9]/g, '-');
    if (key.length <= 200) {
        return key;
    }
    const hash = createArray(path.length, (index) => index).reduce((sum, index) => {
        /** Claude Code hashes UTF-16 code units, which `codePointAt` would merge into code points. */
        // eslint-disable-next-line unicorn/prefer-code-point
        return (sum * 31 + path.charCodeAt(index)) | 0;
    }, 0);
    return `${key.slice(0, 200)}-${Math.abs(hash).toString(36)}`;
}

/**
 * Writes a session's transcript, and its sub-agents' transcripts, from `sessionStore` into Claude
 * Code's `projects` folder for `cwd`, where `--resume` finds them. Does nothing when the store has
 * no transcript for the session.
 */
export async function restoreClaudeTranscript({
    sessionStore,
    sessionId,
    cwd,
    configDir,
}: Readonly<{
    sessionStore: Readonly<SessionStore>;
    sessionId: string;
    cwd: string;
    /** Claude Code's config folder, `~/.claude` unless `CLAUDE_CONFIG_DIR` moves it. */
    configDir: string;
}>) {
    const projectKey = createClaudeProjectKey(await realpath(cwd));
    const projectDir = join(configDir, 'projects', projectKey);
    const [
        entries,
        subpaths,
    ] = await Promise.all([
        sessionStore.load({
            projectKey,
            sessionId,
        }),
        sessionStore.listSubkeys?.({
            projectKey,
            sessionId,
        }) ?? [],
    ]);
    if (!entries?.length) {
        return;
    }
    const subagentDir = join(projectDir, sessionId);
    const subagentFiles = await Promise.all(
        subpaths.map(async (subpath) => {
            const path = join(subagentDir, `${subpath}.jsonl`);
            return relative(subagentDir, path).startsWith('..')
                ? undefined
                : {
                      path,
                      entries: await sessionStore.load({
                          projectKey,
                          sessionId,
                          subpath,
                      }),
                  };
        }),
    );
    await Promise.all(
        [
            {
                path: join(projectDir, `${sessionId}.jsonl`),
                entries,
            },
            ...subagentFiles,
        ].map(async (file) => {
            if (!file?.entries) {
                return;
            }
            await mkdir(dirname(file.path), {
                recursive: true,
                mode: 0o700,
            });
            await writeFile(
                file.path,
                file.entries.map((entry) => `${JSON.stringify(entry)}\n`).join(''),
                {
                    mode: 0o600,
                },
            );
        }),
    );
}
