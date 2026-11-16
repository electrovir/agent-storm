import {
    findNearestFolderSetting,
    PaneKind,
    paneKindRunsAi,
    type AiDefinition,
} from '@agent-storm/common';
import {waitUntil} from '@augment-vir/assert';
import {log, wait} from '@augment-vir/common';
import {normalizePath} from 'agent-storm-util';
import {
    hasClaudeTurnStartedSince,
    isClaudeAwaitingPermission,
    isClaudeReady,
} from './claude-activity.js';
import {attachPane, fetchPaneStatuses} from './daemon/daemon-client.js';
import {defaultSessionId} from './daemon/protocol.js';
import {findParentRepoPath} from './folder-info.js';
import {loadFolderSettings} from './folder-settings.js';
import {getLivePaneSessionIds} from './pty.js';
import {
    findFolderSession,
    findOrCreateFirstSession,
    getFolderSessions,
    markPaneStarted,
} from './sessions.js';
import {findAiDefinition, loadSettings, resolveFolderAi} from './settings.js';

/**
 * Which AI one tab runs: its own override wins, then whatever its folder resolves to. Settings are
 * re-read on every call so a spawn always reflects the user's current choice rather than whatever
 * was set when the pane first opened.
 *
 * Undefined when no AI is defined at all, or when the settings can't be read; the daemon falls back
 * to its built-in default in that case.
 */
export async function resolveAiForSession({
    folder,
    sessionId,
}: Readonly<{
    folder: string;
    sessionId?: string | undefined;
}>): Promise<AiDefinition | undefined> {
    const settings = await loadSettings().catch(() => undefined);
    if (!settings) {
        return undefined;
    }
    const parentRepoPath = findParentRepoPath(folder);
    const resolved = resolveFolderAi({
        settings,
        folderLayers: await loadFolderSettings(folder),
        folder,
        fallbackFolders: parentRepoPath
            ? [
                  parentRepoPath,
              ]
            : [],
    });
    const sessions = await getFolderSessions(folder);
    return (
        findAiDefinition({
            aiDefinitions: resolved.aiDefinitions,
            aiId: sessions[PaneKind.Ai].find((session) => session.id === sessionId)?.aiId,
        }) || resolved.ai
    );
}

/**
 * The command and conversation id a tab's process starts with. A tab whose conversation hasn't
 * started yet gets the AI's new-session command, since resuming would drop it into whichever
 * conversation another tab of the folder is showing. Call `markStarted` once the spawn is done,
 * with whether it left a live process and whether that process is a new one.
 */
export async function resolvePaneLaunch({
    folder,
    kind,
    sessionId,
}: Readonly<{
    folder: string;
    kind: PaneKind;
    sessionId: string;
}>) {
    const [
        aiDefinition,
        session,
    ] = await Promise.all([
        resolveAiForSession({
            folder,
            sessionId,
        }),
        findFolderSession({
            folder,
            kind,
            sessionId,
        }),
    ]);
    const isNewConversation = paneKindRunsAi[kind] && !!session?.isNewConversation;
    return {
        aiCmd:
            isNewConversation && aiDefinition?.newSessionCommand
                ? aiDefinition.newSessionCommand
                : aiDefinition?.resumeSessionCommand,
        conversationId: session?.conversationId,
        async markStarted({isRunning, isNew}: Readonly<{isRunning: boolean; isNew: boolean}>) {
            if (paneKindRunsAi[kind] && isRunning && (isNew || isNewConversation)) {
                await markPaneStarted({
                    folder,
                    kind,
                    sessionId,
                    launchedAiId: aiDefinition?.id || '',
                });
            }
        },
    };
}

/** Starts a tab's process, if it isn't running, the same way opening its pane would. */
export async function spawnPane({
    folder,
    kind,
    sessionId,
    env,
}: Readonly<{
    folder: string;
    kind: PaneKind;
    sessionId: string;
    /** Applied only if this call starts the tab. See `AttachHandshake.env`. */
    env?: Readonly<Record<string, string>> | undefined;
}>) {
    const launch = await resolvePaneLaunch({
        folder,
        kind,
        sessionId,
    });
    const attachment = await attachPane({
        folder,
        kind,
        sessionId,
        aiCmd: launch.aiCmd,
        conversationId: launch.conversationId,
        env,
        onData() {},
        onExit() {},
    });
    await launch.markStarted(attachment);
    attachment.close();
}

/** Types `text` into a tab and submits it, starting the tab first if it isn't running. */
export async function sendPaneText({
    folder: folderPath,
    kind,
    sessionId,
    text,
    env,
}: Readonly<{
    folder: string;
    kind: PaneKind;
    sessionId: string;
    text: string;
    /** Applied only if this call starts the tab. See `AttachHandshake.env`. */
    env?: Readonly<Record<string, string>> | undefined;
}>) {
    const folder = normalizePath(folderPath);
    if (!(await getLivePaneSessionIds(folder, kind)).includes(sessionId)) {
        await spawnPane({
            folder,
            kind,
            sessionId,
            env,
        });
    }
    const conversationId = paneKindRunsAi[kind]
        ? (
              await findFolderSession({
                  folder,
                  kind,
                  sessionId,
              })
          )?.conversationId
        : undefined;
    if (conversationId) {
        try {
            await waitUntil.isTrue(() => isClaudeReady(conversationId), {
                interval: {
                    milliseconds: 200,
                },
                timeout: {
                    seconds: 30,
                },
            });
        } catch {
            /** Other AIs never report ready, so they get the text once the wait runs out. */
        }
        if (await isClaudeAwaitingPermission(conversationId)) {
            throw new Error(
                'That tab is waiting on a permission prompt. Answer it before sending text.',
            );
        }
    }
    const attachment = await attachPane({
        folder,
        kind,
        sessionId,
        onData() {},
        onExit() {},
    });
    const sentAt = Date.now();
    attachment.write(text);
    /** Enter goes on its own, after a pause, so it reads as a keypress rather than typed text. */
    await wait({
        milliseconds: 200,
    });
    attachment.write('\r');
    if (conversationId) {
        /**
         * Text that lands before a just-started Claude reads its input is taken in later as one
         * paste with the Enters stripped out ("Removed 1 invisible character · review and press
         * Enter to send"), and sits unsent. Claude ignores Enter on an empty input, so Enter is
         * repeated until Claude's hook reports the prompt.
         */
        await wait({
            seconds: 1,
        });
        await waitUntil
            .isTrue(
                async () => {
                    if (
                        await hasClaudeTurnStartedSince({
                            conversationId,
                            since: sentAt,
                        })
                    ) {
                        return true;
                    }
                    attachment.write('\r');
                    return false;
                },
                {
                    interval: {
                        seconds: 2,
                    },
                    timeout: {
                        seconds: 20,
                    },
                },
            )
            .catch(() => {
                log.warning(`Claude in ${folder} never reported the prompt sent to it.`);
            });
    } else if (paneKindRunsAi[kind]) {
        /**
         * Some runs leave the text sitting unsent in the AI's input box after the first Enter. A
         * second Enter sends it then.
         */
        await wait({
            seconds: 1,
        });
        attachment.write('\r');
    }
    attachment.close();
}

/** Types `prompt` into a folder's first AI tab, opening and starting one first if needed. */
export async function launchFolderSession({
    folder,
    prompt,
    env,
}: Readonly<{
    folder: string;
    prompt: string;
    /** Applied only if this call starts the tab. See `AttachHandshake.env`. */
    env?: Readonly<Record<string, string>> | undefined;
}>) {
    await sendPaneText({
        folder,
        env,
        kind: PaneKind.Ai,
        sessionId: await findOrCreateFirstSession({
            folder,
            kind: PaneKind.Ai,
        }),
        /**
         * A newline would submit the prompt partway through, and an escape sequence would read as
         * key presses.
         */
        text: prompt.replaceAll(/\p{Cc}+/gu, ' ').trim(),
    });
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
}: Readonly<{
    repoPath: string;
    worktreePath: string;
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
            sessionId: await findOrCreateFirstSession({
                folder: worktreePath,
                kind: PaneKind.Shell,
            }),
        });
    }
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
    const isShellBusy = (await fetchPaneStatuses()).some((entry) => {
        return (
            entry.folder === folder &&
            entry.kind === PaneKind.Shell &&
            (entry.sessionId || defaultSessionId) === shellSessionId &&
            entry.isRunningCommand
        );
    });
    if (isShellBusy) {
        return false;
    }
    await runInShellPane({
        folder,
        command,
        sessionId: shellSessionId,
    });
    return true;
}
