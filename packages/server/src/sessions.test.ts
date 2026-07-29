import {PaneKind} from '@agent-storm/common';
import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
    createFolderSession,
    forgetFolderSessions,
    getFolderSessions,
    parseSessionStore,
    reconcileFolderSessions,
    removeFolderSession,
    renameFolderSession,
    resolveSessionId,
} from './sessions.js';

/**
 * The store is a module-level singleton persisted to a file that outlives the test process, so
 * tests must not share folder paths — a fixed path would accumulate sessions across runs and drift.
 * A fresh temp directory per test keeps each one hermetic.
 */
async function withTempFolder(run: (folder: string) => Promise<void>): Promise<void> {
    const folder = await mkdtemp(join(tmpdir(), 'agent-storm-sessions-'));
    try {
        await run(folder);
    } finally {
        await rm(folder, {
            recursive: true,
            force: true,
        });
    }
}

describe(getFolderSessions.name, () => {
    it('materializes one default session per kind for an unknown folder', async () => {
        await withTempFolder(async (folder) => {
            const sessions = await getFolderSessions(folder);

            assert.isLengthExactly(sessions.ai, 1);
            assert.isLengthExactly(sessions.shell, 1);
            /**
             * The first session must use the shared default id: an attach that carries no
             * `sessionId` resolves to that same value, so any other id here would strand it on a
             * PTY with no tab.
             */
            assert.strictEquals(sessions.ai[0].id, 'default');
            assert.strictEquals(sessions.shell[0].id, 'default');
        });
    });

    it('treats differently-written paths for the same folder as one entry', async () => {
        await withTempFolder(async (folder) => {
            const created = await createFolderSession({
                folder,
                kind: PaneKind.Ai,
            });
            /** A trailing `/.` must resolve to the same store key. */
            const viaOtherSpelling = await getFolderSessions(`${folder}/./`);

            assert.isLengthExactly(created.ai, 2);
            assert.deepEquals(
                viaOtherSpelling.ai.map((session) => session.id),
                created.ai.map((session) => session.id),
            );
        });
    });
});

describe(createFolderSession.name, () => {
    it('appends sessions and leaves the other kind untouched', async () => {
        await withTempFolder(async (folder) => {
            const afterFirst = await createFolderSession({
                folder,
                kind: PaneKind.Ai,
            });
            const afterSecond = await createFolderSession({
                folder,
                kind: PaneKind.Ai,
            });

            assert.isLengthExactly(afterFirst.ai, 2);
            assert.isLengthExactly(afterSecond.ai, 3);
            assert.isLengthExactly(afterSecond.shell, 1);
            /** Ids must be unique or two tabs would drive the same PTY. */
            assert.strictEquals(new Set(afterSecond.ai.map((session) => session.id)).size, 3);
        });
    });
});

describe(renameFolderSession.name, () => {
    it('sets and clears a session name', async () => {
        await withTempFolder(async (folder) => {
            const initial = await getFolderSessions(folder);
            const sessionId = initial.ai[0]?.id || '';

            const named = await renameFolderSession({
                folder,
                kind: PaneKind.Ai,
                sessionId,
                name: '  backend  ',
            });
            const cleared = await renameFolderSession({
                folder,
                kind: PaneKind.Ai,
                sessionId,
                name: '',
            });

            assert.strictEquals(named.ai[0]?.name, 'backend');
            assert.strictEquals(cleared.ai[0]?.name, '');
        });
    });
});

describe(removeFolderSession.name, () => {
    it('refuses to remove the last session of a kind', async () => {
        await withTempFolder(async (folder) => {
            const initial = await getFolderSessions(folder);

            const result = await removeFolderSession({
                folder,
                kind: PaneKind.Ai,
                sessionId: initial.ai[0]?.id || '',
            });

            assert.isFalse(result.removed);
            assert.isLengthExactly(result.sessions.ai, 1);
        });
    });

    it('removes a session once a sibling exists', async () => {
        await withTempFolder(async (folder) => {
            const created = await createFolderSession({
                folder,
                kind: PaneKind.Shell,
            });
            const doomedId = created.shell[1]?.id || '';

            const result = await removeFolderSession({
                folder,
                kind: PaneKind.Shell,
                sessionId: doomedId,
            });

            assert.isTrue(result.removed);
            assert.isLengthExactly(result.sessions.shell, 1);
            assert.isFalse(result.sessions.shell.some((session) => session.id === doomedId));
        });
    });
});

describe(reconcileFolderSessions.name, () => {
    it('adopts a live pty that has no stored tab', async () => {
        await withTempFolder(async (folder) => {
            const reconciled = await reconcileFolderSessions({
                folder,
                liveSessionIds: {
                    [PaneKind.Ai]: ['orphaned-pty'],
                    [PaneKind.Shell]: [],
                },
            });

            /**
             * An unlisted PTY would be invisible in the UI while still running an agent process, so
             * it gets a tab appended rather than being left unreachable.
             */
            assert.isTrue(reconciled.ai.some((session) => session.id === 'orphaned-pty'));
        });
    });
});

describe(resolveSessionId.name, () => {
    it('falls back to the first session for unknown or missing ids', async () => {
        await withTempFolder(async (folder) => {
            const initial = await getFolderSessions(folder);
            const firstId = initial.ai[0]?.id || '';

            assert.strictEquals(
                await resolveSessionId({
                    folder,
                    kind: PaneKind.Ai,
                    sessionId: 'not-a-real-session',
                }),
                firstId,
            );
            assert.strictEquals(
                await resolveSessionId({
                    folder,
                    kind: PaneKind.Ai,
                    sessionId: undefined,
                }),
                firstId,
            );
        });
    });

    it('keeps an id that exists', async () => {
        await withTempFolder(async (folder) => {
            const created = await createFolderSession({
                folder,
                kind: PaneKind.Ai,
            });
            const secondId = created.ai[1]?.id || '';

            assert.strictEquals(
                await resolveSessionId({
                    folder,
                    kind: PaneKind.Ai,
                    sessionId: secondId,
                }),
                secondId,
            );
        });
    });
});

describe(forgetFolderSessions.name, () => {
    it('drops a folder so a later folder at the same path starts clean', async () => {
        await withTempFolder(async (folder) => {
            const created = await createFolderSession({
                folder,
                kind: PaneKind.Ai,
            });
            await renameFolderSession({
                folder,
                kind: PaneKind.Ai,
                sessionId: created.ai[1]?.id || '',
                name: 'from-a-deleted-worktree',
            });

            await forgetFolderSessions(folder);
            const afterForget = await getFolderSessions(folder);

            /**
             * Worktree paths are derived from the worktree name, so recreating one with a
             * previously-used name lands on this same path. Without the prune it would inherit the
             * old incarnation's tabs and names.
             */
            assert.isLengthExactly(afterForget.ai, 1);
            assert.strictEquals(afterForget.ai[0].name, '');
        });
    });
});

describe(parseSessionStore.name, () => {
    it('yields an empty store for unusable contents', () => {
        /**
         * A truncated or hand-mangled cache file must cost tab names at worst — never throw, which
         * on the read path would take the backend down at startup.
         */
        assert.deepEquals(parseSessionStore('{ this is not json'), {});
        assert.deepEquals(parseSessionStore('null'), {});
        assert.deepEquals(parseSessionStore('[]'), {});
    });

    it('drops entries whose sessions are malformed', () => {
        const parsed = parseSessionStore(
            JSON.stringify({
                '/tmp/keeps-valid': {
                    ai: [
                        {
                            id: 'a',
                            name: 'named',
                        },
                    ],
                    shell: [],
                },
                '/tmp/drops-no-id': {
                    ai: [
                        {
                            name: 'no id here',
                        },
                    ],
                    shell: [],
                },
            }),
        );

        assert.deepEquals(parsed['/tmp/keeps-valid'], {
            ai: [
                {
                    id: 'a',
                    name: 'named',
                },
            ],
            shell: [],
        });
        assert.isUndefined(parsed['/tmp/drops-no-id']);
    });

    it('defaults a missing name to empty', () => {
        const parsed = parseSessionStore(
            JSON.stringify({
                '/tmp/nameless': {
                    ai: [
                        {
                            id: 'a',
                        },
                    ],
                    shell: [],
                },
            }),
        );

        assert.strictEquals(parsed['/tmp/nameless']?.ai[0]?.name, '');
    });
});
