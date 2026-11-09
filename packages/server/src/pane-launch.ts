import {PaneKind, paneKindRunsAi, type AiDefinition} from '@agent-storm/common';
import {waitUntil} from '@augment-vir/assert';
import {log, wait} from '@augment-vir/common';
import {normalizePath} from 'agent-storm';
import {isClaudeAwaitingPermission, isClaudeReady} from './claude-activity.js';
import {attachPane, fetchPaneStatuses} from './daemon/daemon-client.js';
import {defaultSessionId} from './daemon/protocol.js';
import {findParentRepoPath} from './folder-info.js';
import {findNearestFolderSetting, loadFolderSettings} from './folder-settings.js';
import {resolveReviewFolder} from './github-review-queue.js';
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
}: Readonly<{
    folder: string;
    kind: PaneKind;
    sessionId: string;
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
        onData() {},
        onExit() {},
    });
    await launch.markStarted(attachment);
    attachment.close();
}

/** Types `text` into a tab and submits it, waiting for a tab that is still starting up. */
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
    /** A pane opened just before this request has no PTY until its terminal attaches. */
    await waitUntil.isTrue(
        async () => {
            return (await getLivePaneSessionIds(folder, kind)).includes(sessionId);
        },
        {
            interval: {
                milliseconds: 200,
            },
            timeout: {
                seconds: 30,
            },
        },
        'That session is not running. Open its pane first.',
    );
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
    attachment.write(text);
    /** Enter goes on its own, after a pause, so it reads as a keypress rather than typed text. */
    await wait({
        milliseconds: 200,
    });
    attachment.write('\r');
    /**
     * Some runs leave the text sitting unsent in Claude's input box after the first Enter. A second
     * Enter sends it then, and does nothing when the first already went through, since Claude
     * ignores Enter on an empty input.
     */
    if (paneKindRunsAi[kind]) {
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
}: Readonly<{
    folder: string;
    prompt: string;
}>) {
    const sessionId = await findOrCreateFirstSession({
        folder,
        kind: PaneKind.Ai,
    });
    if (!(await getLivePaneSessionIds(folder, PaneKind.Ai)).includes(sessionId)) {
        await spawnPane({
            folder,
            kind: PaneKind.Ai,
            sessionId,
        });
    }
    await sendPaneText({
        folder,
        kind: PaneKind.Ai,
        sessionId,
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
 * Runs the first review init command found in a PR's review folder: the user's command for the PR's
 * repo, then the nearest folder settings file's, then the user's global one.
 */
export async function runReviewInitCmd({
    owner,
    repoName,
    number,
}: Readonly<{owner: string; repoName: string; number: number}>) {
    const [
        reviewFolder,
        settings,
    ] = await Promise.all([
        resolveReviewFolder({
            owner,
            repoName,
            number,
            createFolder: false,
        }),
        loadSettings().catch(() => undefined),
    ]);
    if (!settings) {
        return;
    }
    const command =
        settings.review.repos.find((repo) => {
            return repo.owner === owner && repo.repoName === repoName;
        })?.initCmd ||
        findNearestFolderSetting(
            await loadFolderSettings(reviewFolder.folder),
            (folderSettings) => folderSettings.review?.initCmd,
        ) ||
        settings.review.initCmd;
    if (!command) {
        return;
    }
    /**
     * The shell's foreground process is also something other than the shell when the user's shell
     * starts tmux or similar, so this errs on the side of not typing.
     */
    const shellSessionId = await findOrCreateFirstSession({
        folder: reviewFolder.folder,
        kind: PaneKind.Shell,
    });
    const isShellBusy = (await fetchPaneStatuses()).some((entry) => {
        return (
            entry.folder === reviewFolder.folder &&
            entry.kind === PaneKind.Shell &&
            (entry.sessionId || defaultSessionId) === shellSessionId &&
            entry.isRunningCommand
        );
    });
    if (isShellBusy) {
        log.warning(
            `Not running the review init command in ${reviewFolder.folder}: its shell tab is running something.`,
        );
        return;
    }
    await runInShellPane({
        folder: reviewFolder.folder,
        command,
        sessionId: shellSessionId,
    });
}
