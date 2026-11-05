import {PaneKind, paneKindRunsAi, type AiDefinition} from '@agent-storm/common';
import {check, waitUntil} from '@augment-vir/assert';
import {log, wait} from '@augment-vir/common';
import {isClaudeAwaitingPermission, isClaudeReady} from './claude-activity.js';
import {findAiDefinition, getFolderAiDefinition, loadConfig} from './config.js';
import {attachPane, fetchPaneStatuses} from './daemon/daemon-client.js';
import {defaultSessionId} from './daemon/protocol.js';
import {listWorktreeChildren} from './git.js';
import {resolveReviewFolder} from './github-review-queue.js';
import {normalizePath} from './paths.js';
import {getLivePaneSessionIds} from './pty.js';
import {loadReviewConfig} from './review-config.js';
import {findFolderSession, getFolderSessions, markConversationStarted} from './sessions.js';

/**
 * Which AI one tab runs: its own override wins, then its folder's override, then the worktree
 * root's, then the global default. Config is re-read on every call so a spawn always reflects the
 * user's current choice rather than whatever was set when the pane first opened.
 *
 * Undefined when the user has defined no AI at all, or when config can't be read; the daemon falls
 * back to its built-in default in that case.
 */
export async function resolveAiForSession({
    folder,
    sessionId,
}: Readonly<{
    folder: string;
    sessionId?: string | undefined;
}>): Promise<AiDefinition | undefined> {
    const config = await loadConfig().catch(() => undefined);
    if (!config) {
        return undefined;
    }
    const sessions = await getFolderSessions(folder);
    const sessionAi = findAiDefinition({
        config,
        aiId: sessions[PaneKind.Ai].find((session) => session.id === sessionId)?.aiId,
    });
    if (sessionAi) {
        return sessionAi;
    }
    const parentRepoMatches = await Promise.all(
        config.repos.map(async (repo) => {
            const children = await listWorktreeChildren(repo.path);
            return children.includes(folder) ? repo.path : undefined;
        }),
    );
    return getFolderAiDefinition({
        config,
        folder,
        fallbackFolders: parentRepoMatches.filter(check.isTruthy),
    });
}

/**
 * The command and conversation id a tab's process starts with. A tab whose conversation hasn't
 * started yet gets the AI's new-session command, since resuming would drop it into whichever
 * conversation another tab of the folder is showing. Call `markStarted` once the spawn is done,
 * with whether it left a live process.
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
        async markStarted(isRunning: boolean) {
            if (isNewConversation && isRunning) {
                await markConversationStarted({
                    folder,
                    kind,
                    sessionId,
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
    await launch.markStarted(attachment.isRunning);
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

/** Types `prompt` into a folder's first AI tab, starting that tab first if it isn't running. */
export async function launchFolderSession({
    folder,
    prompt,
}: Readonly<{
    folder: string;
    prompt: string;
}>) {
    const sessionId = (await getFolderSessions(folder))[PaneKind.Ai][0]?.id;
    if (!sessionId) {
        return;
    }
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

/** Types `command` into a folder's first shell tab and runs it, starting the tab if needed. */
async function runInShellPane({folder, command}: Readonly<{folder: string; command: string}>) {
    const attachment = await attachPane({
        folder,
        kind: PaneKind.Shell,
        onData() {},
        onExit() {},
    });
    attachment.write(`${command}\n`);
    attachment.close();
}

/** Runs the repo's post-worktree command, or the global one, in a freshly created worktree. */
export async function runPostWorktreeCmd({
    repoPath,
    worktreePath,
}: Readonly<{
    repoPath: string;
    worktreePath: string;
}>) {
    /** The command is optional, so an unreadable config skips it instead of failing the create. */
    const config = await loadConfig().catch(() => undefined);
    if (!config) {
        return;
    }
    const command =
        config.repos.find((repo) => repo.path === repoPath)?.postWorktreeCmd ||
        config.postWorktreeCmd;
    if (command) {
        await runInShellPane({
            folder: worktreePath,
            command,
        });
    }
}

/** Runs the review config's init command for a PR's repo in the PR's review folder. */
export async function runReviewInitCmd({
    owner,
    repoName,
    number,
}: Readonly<{owner: string; repoName: string; number: number}>) {
    const [
        reviewFolder,
        reviewConfig,
    ] = await Promise.all([
        resolveReviewFolder({
            owner,
            repoName,
            number,
            createFolder: false,
        }),
        loadReviewConfig(),
    ]);
    const command =
        reviewConfig.repos.find((repo) => {
            return repo.owner === owner && repo.repoName === repoName;
        })?.initCmd || reviewConfig.defaultInitCmd;
    if (!command) {
        return;
    }
    /**
     * The shell's foreground process is also something other than the shell when the user's shell
     * starts tmux or similar, so this errs on the side of not typing.
     */
    const isShellBusy = (await fetchPaneStatuses()).some((entry) => {
        return (
            entry.folder === reviewFolder.folder &&
            entry.kind === PaneKind.Shell &&
            (entry.sessionId || defaultSessionId) === defaultSessionId &&
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
    });
}
