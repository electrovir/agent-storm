import {findNearestFolderSetting, PaneKind} from '@agent-storm/common';
import {assertWrap} from '@augment-vir/assert';
import {wait} from '@augment-vir/common';
import {normalizePath} from 'agent-storm-util';
import {attachPane, fetchPaneStatuses} from './daemon/daemon-client.js';
import {defaultSessionId} from './daemon/protocol.js';
import {loadFolderSettings} from './folder-settings.js';
import {getLivePaneSessionIds} from './pty.js';
import {createFolderSession, findOrCreateFirstSession} from './sessions.js';
import {loadSettings} from './settings.js';

/** Starts a tab's process, if it isn't running, the same way opening its pane would. */
export async function spawnPane({
    folder,
    kind,
    sessionId,
}: Readonly<{
    folder: string;
    kind: PaneKind;
    sessionId: string;
}>) {
    const attachment = await attachPane({
        folder,
        kind,
        sessionId,
        onData() {},
        onExit() {},
    });
    attachment.close();
}

/** Types `text` into a tab and submits it, starting the tab first if it isn't running. */
export async function sendPaneText({
    folder: folderPath,
    kind,
    sessionId,
    text,
}: Readonly<{
    folder: string;
    kind: PaneKind;
    sessionId: string;
    text: string;
}>) {
    const folder = normalizePath(folderPath);
    if (!(await getLivePaneSessionIds(folder, kind)).includes(sessionId)) {
        await spawnPane({
            folder,
            kind,
            sessionId,
        });
    }
    const attachment = await attachPane({
        folder,
        kind,
        sessionId,
        onData() {},
        onExit() {},
    });
    attachment.write(text);
    /** Enter goes on its own, after a pause, so it reads as a keypress rather than typed text. */
    await wait({
        milliseconds: 200,
    });
    attachment.write('\r');
    attachment.close();
}

/** Types `command` into a folder's shell tab and runs it, starting the tab if needed. */
async function runInShellPane({
    folder,
    command,
    sessionId,
}: Readonly<{
    folder: string;
    command: string;
    sessionId: string;
}>) {
    const attachment = await attachPane({
        folder,
        kind: PaneKind.Shell,
        sessionId,
        onData() {},
        onExit() {},
    });
    attachment.write(`${command}\n`);
    attachment.close();
}

/**
 * Runs the first post-worktree command found in a freshly created worktree: the user's command for
 * the repo, then the nearest folder settings file's, then the user's global one.
 */
export async function runPostWorktreeCmd({
    repoPath,
    worktreePath,
    scope,
}: Readonly<{
    repoPath: string;
    worktreePath: string;
    /**
     * The pane group that gets a new shell tab to run the command in. Without one, the folder's
     * first shell tab runs it.
     */
    scope?: string | undefined;
}>) {
    /** The command is optional, so unreadable settings skip it instead of failing the create. */
    const settings = await loadSettings().catch(() => undefined);
    if (!settings) {
        return;
    }
    const normalizedRepoPath = normalizePath(repoPath);
    const command =
        settings.folderPostWorktreeCmds.find((entry) => entry.folder === normalizedRepoPath)
            ?.postWorktreeCmd ||
        findNearestFolderSetting(
            await loadFolderSettings(worktreePath),
            (folderSettings) => folderSettings.postWorktreeCmd,
        ) ||
        settings.postWorktreeCmd;
    if (command) {
        await runInShellPane({
            folder: worktreePath,
            command,
            sessionId: scope
                ? assertWrap.isDefined(
                      (
                          await createFolderSession({
                              folder: worktreePath,
                              kind: PaneKind.Shell,
                              scope,
                          })
                      )[PaneKind.Shell].at(-1),
                  ).id
                : await findOrCreateFirstSession({
                      folder: worktreePath,
                      kind: PaneKind.Shell,
                  }),
        });
    }
}

/** Whether the tab's foreground process is something other than its shell. */
export async function isPaneRunningCommand({
    folder,
    sessionId,
}: Readonly<{
    folder: string;
    sessionId: string;
}>) {
    const normalizedFolder = normalizePath(folder);
    return (await fetchPaneStatuses()).some((entry) => {
        return (
            entry.folder === normalizedFolder &&
            (entry.sessionId || defaultSessionId) === sessionId &&
            !!entry.isRunningCommand
        );
    });
}

/**
 * Types `command` into the folder's first shell tab, making one when it has none. False, without
 * typing anything, while that tab is running something.
 */
export async function runInIdleFolderShell({
    folder,
    command,
}: Readonly<{
    folder: string;
    command: string;
}>) {
    /**
     * The shell's foreground process is also something other than the shell when the user's shell
     * starts tmux or similar, so this errs on the side of not typing.
     */
    const shellSessionId = await findOrCreateFirstSession({
        folder,
        kind: PaneKind.Shell,
    });
    if (
        await isPaneRunningCommand({
            folder,
            sessionId: shellSessionId,
        })
    ) {
        return false;
    }
    await runInShellPane({
        folder,
        command,
        sessionId: shellSessionId,
    });
    return true;
}
