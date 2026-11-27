import {PaneKind, type SessionMeta} from '@agent-storm/common';
import {assert, assertWrap} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {
    createFolderSession,
    findOrCreateFirstSession,
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
function storedSession(overrides: Readonly<Partial<SessionMeta>>): SessionMeta {
    return {
        id: 'stored',
        name: '',
        ...overrides,
    };
}

async function withTempFolder(run: (folder: string) => Promise<void>): Promise<void> {
    const folder = await mkdtemp(join(tmpdir(), 'agent-storm-sessions-'));
    try {
        await run(folder);
    } finally {
        await forgetFolderSessions(folder);
        await rm(folder, {
            recursive: true,
            force: true,
        });
    }
}

describe(getFolderSessions.name, () => {
    it('materializes a default session for an unknown folder', async () => {
        await withTempFolder(async (folder) => {
            const sessions = await getFolderSessions(folder);

            assert.isLengthExactly(sessions.shell, 1);
            /**
             * The first session must use the shared default id: an attach that carries no
             * `sessionId` resolves to that same value, so any other id here would strand it on a
             * PTY with no tab.
             */
            assert.strictEquals(sessions.shell[0].id, 'default');
        });
    });

    it('treats differently-written paths for the same folder as one entry', async () => {
        await withTempFolder(async (folder) => {
            const created = await createFolderSession({
                folder,
                kind: PaneKind.Shell,
            });
            /** A trailing `/.` must resolve to the same store key. */
            const viaOtherSpelling = await getFolderSessions(`${folder}/./`);

            assert.isLengthExactly(created.shell, 2);
            assert.deepEquals(
                viaOtherSpelling.shell.map((session) => session.id),
                created.shell.map((session) => session.id),
            );
        });
    });

    it('shares default sessions across concurrent reads', async () => {
        await withTempFolder(async (folder) => {
            const [
                first,
                second,
            ] = await Promise.all([
                getFolderSessions(folder),
                getFolderSessions(`${folder}/./`),
            ]);

            assert.deepEquals(first, second);
        });
    });
});

describe(createFolderSession.name, () => {
    it('appends sessions with unique ids', async () => {
        await withTempFolder(async (folder) => {
            const afterFirst = await createFolderSession({
                folder,
                kind: PaneKind.Shell,
            });
            const afterSecond = await createFolderSession({
                folder,
                kind: PaneKind.Shell,
            });

            assert.isLengthExactly(afterFirst.shell, 2);
            assert.isLengthExactly(afterSecond.shell, 3);
            /** Ids must be unique or two tabs would drive the same PTY. */
            assert.strictEquals(new Set(afterSecond.shell.map((session) => session.id)).size, 3);
        });
    });

    it('keeps a new tab when another tab is renamed concurrently', async () => {
        await withTempFolder(async (folder) => {
            const original = assertWrap.isDefined((await getFolderSessions(folder)).shell[0]);
            const [created] = await Promise.all([
                createFolderSession({
                    folder,
                    kind: PaneKind.Shell,
                }),
                renameFolderSession({
                    folder,
                    kind: PaneKind.Shell,
                    sessionId: original.id,
                    name: 'Renamed tab',
                }),
            ]);

            assert.deepEquals((await getFolderSessions(folder)).shell, [
                {
                    ...original,
                    name: 'Renamed tab',
                },
                assertWrap.isDefined(created.shell.at(-1)),
            ]);
        });
    });
});

describe(findOrCreateFirstSession.name, () => {
    it('shares a replacement tab across concurrent opens', async () => {
        await withTempFolder(async (folder) => {
            const initial = await getFolderSessions(folder);
            const target = {
                folder,
                kind: PaneKind.Shell,
            };
            await removeFolderSession({
                ...target,
                sessionId: assertWrap.isDefined(initial.shell[0]).id,
            });
            const [
                first,
                second,
            ] = await Promise.all([
                findOrCreateFirstSession(target),
                findOrCreateFirstSession(target),
            ]);

            assert.strictEquals(first, second);
            assert.deepEquals(
                (await getFolderSessions(folder)).shell.map(({id}) => id),
                [
                    first,
                ],
            );
        });
    });
});

describe(renameFolderSession.name, () => {
    it('sets and clears a session name', async () => {
        await withTempFolder(async (folder) => {
            const initial = await getFolderSessions(folder);
            const sessionId = initial.shell[0]?.id || '';

            const named = await renameFolderSession({
                folder,
                kind: PaneKind.Shell,
                sessionId,
                name: '  backend  ',
            });
            const cleared = await renameFolderSession({
                folder,
                kind: PaneKind.Shell,
                sessionId,
                name: '',
            });

            assert.strictEquals(named.shell[0]?.name, 'backend');
            assert.strictEquals(cleared.shell[0]?.name, '');
        });
    });
});

describe(removeFolderSession.name, () => {
    it('removes the last session of a kind and keeps the kind empty', async () => {
        await withTempFolder(async (folder) => {
            const initial = await getFolderSessions(folder);

            const result = await removeFolderSession({
                folder,
                kind: PaneKind.Shell,
                sessionId: initial.shell[0]?.id || '',
            });

            assert.isTrue(result.removed);
            assert.isLengthExactly(result.sessions.shell, 0);
            assert.isLengthExactly((await getFolderSessions(folder)).shell, 0);
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
                    [PaneKind.Shell]: ['orphaned-pty'],
                },
            });

            /**
             * An unlisted PTY would be invisible in the UI while still running an agent process, so
             * it gets a tab appended rather than being left unreachable.
             */
            assert.isTrue(reconciled.shell.some((session) => session.id === 'orphaned-pty'));
        });
    });
});

describe(resolveSessionId.name, () => {
    it('falls back to the first session for unknown or missing ids', async () => {
        await withTempFolder(async (folder) => {
            const initial = await getFolderSessions(folder);
            const firstId = initial.shell[0]?.id || '';

            assert.strictEquals(
                await resolveSessionId({
                    folder,
                    kind: PaneKind.Shell,
                    sessionId: 'not-a-real-session',
                }),
                firstId,
            );
            assert.strictEquals(
                await resolveSessionId({
                    folder,
                    kind: PaneKind.Shell,
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
                kind: PaneKind.Shell,
            });
            const secondId = created.shell[1]?.id || '';

            assert.strictEquals(
                await resolveSessionId({
                    folder,
                    kind: PaneKind.Shell,
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
                kind: PaneKind.Shell,
            });
            await renameFolderSession({
                folder,
                kind: PaneKind.Shell,
                sessionId: created.shell[1]?.id || '',
                name: 'from-a-deleted-worktree',
            });

            await forgetFolderSessions(folder);
            const afterForget = await getFolderSessions(folder);

            /**
             * Worktree paths are derived from the worktree name, so recreating one with a
             * previously-used name lands on this same path. Without the prune it would inherit the
             * old incarnation's tabs and names.
             */
            assert.isLengthExactly(afterForget.shell, 1);
            assert.strictEquals(afterForget.shell[0].name, '');
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

    it('drops folders that do not match the shape, and sessions with no id', () => {
        const parsed = parseSessionStore(
            JSON.stringify({
                [resolve('/tmp/keeps-valid')]: {
                    shell: [
                        storedSession({
                            id: 'a',
                            name: 'named',
                        }),
                        storedSession({
                            id: '',
                        }),
                    ],
                },
                [resolve('/tmp/drops-missing-fields')]: {
                    shell: [
                        {
                            id: 'b',
                        },
                    ],
                },
            }),
        );

        assert.deepEquals(parsed, {
            [resolve('/tmp/keeps-valid')]: {
                shell: [
                    storedSession({
                        id: 'a',
                        name: 'named',
                    }),
                ],
            },
        });
    });
});
