import {homedir, tmpdir} from 'node:os';
import {basename, resolve} from 'node:path';

export const monorepoRoot = resolve(import.meta.dirname, '..', '..', '..');

/** Git-ignored directory at the repo root for runtime secrets and on-disk caches. */
export const notCommittedDir = resolve(monorepoRoot, '.not-committed');

/** Agent-storm's user-level files: config, its backups, and anything else that outlives a checkout. */
export const userDataDir = resolve(homedir(), '.agent-storm');

/**
 * Argon2id hash of the bearer secret used for browser ↔ backend auth. Only the hash is stored on
 * disk; the cleartext is shown once at startup and is required by the client.
 */
export const authSecretPath = resolve(notCommittedDir, 'auth-secret');

/**
 * Filename portion of {@link authSecretPath}, used to filter `fs.watch` events on
 * {@link notCommittedDir} (the watcher delivers basenames, not full paths).
 */
export const authSecretFileName = basename(authSecretPath);

/**
 * Persisted folder-info cache so the sidebar reappears with last-known git/PR/pane state on server
 * restart instead of waiting a full sweep cycle to repopulate.
 */
export const folderInfoCachePath = resolve(notCommittedDir, 'folder-info-cache.json');

/**
 * Persisted GitHub PR cache + auto-disable state. Survives server restarts so `tsx --watch` reloads
 * during dev don't blow away the 10-minute PR cache and trigger a fresh round of GraphQL fetches on
 * every file save, and so a rate-limit/auth auto-disable sticks until its expiry rather than
 * resetting on every restart.
 */
export const githubCachePath = resolve(notCommittedDir, 'github-cache.json');

/**
 * Per-folder session tab lists (order + user-assigned names) for each pane kind. Lives here rather
 * than in {@link configPath} because it's app state, not a hand-editable setting — but it still has
 * to survive daemon and server restarts, since a tab name the user typed can't be regenerated the
 * way git or PR state can.
 */
export const sessionStorePath = resolve(notCommittedDir, 'pane-sessions.json');

/**
 * Per-folder timestamp of the last keystroke the user sent to one of that folder's panes, backing
 * the sidebar's "Sort by activity" option. Persisted because the ordering it produces is only
 * useful if it spans the days the user has been working, not the current server process.
 */
export const folderActivityPath = resolve(notCommittedDir, 'folder-activity.json');

/**
 * Where wrapper scripts record which CLI session each tab's conversation maps to, one file per
 * conversation id under a per-CLI subdirectory. Agent-storm never reads these files, it only
 * deletes a conversation's files once no tab holds that conversation anymore.
 */
export const conversationStateDir = resolve(userDataDir, 'conversations');

/**
 * Where `claude-hooks/agent-storm-activity.sh` records what Claude is doing in each tab. Sits under
 * {@link conversationStateDir} so a conversation's file is deleted along with its other state.
 */
export const claudeActivityDir = resolve(conversationStateDir, 'claude-activity');

/** Repo copies of the Claude Code hook scripts, the source of truth for what gets installed. */
export const claudeHookSourceDir = resolve(import.meta.dirname, 'claude-hooks');

/** Where the hook scripts are installed to. Claude Code's settings reference them by this path. */
export const claudeHookInstallDir = resolve(homedir(), '.claude');

/** Claude Code's user-level settings, where agent-storm registers its hooks. */
export const claudeSettingsPath = resolve(claudeHookInstallDir, 'settings.json');

/** Unix domain socket the pty daemon listens on for new pane attachments. */
export const daemonSocketPath = resolve(tmpdir(), 'agent-storm-pty.sock');

/** Where the pty daemon's stdout/stderr is redirected (it runs detached from the server). */
export const daemonLogPath = resolve(tmpdir(), 'agent-storm-pty-daemon.log');

/**
 * Mirror of the backend's stdout/stderr written from `index.ts`. Lets the assistant tail a file
 * instead of asking the user to copy/paste console output, especially when debugging WS / proxy
 * flows where the relevant log lines are dense and time-ordered.
 */
export const serverLogPath = resolve(tmpdir(), 'agent-storm-server.log');

/**
 * Browser-side errors, shipped to the backend by the frontend's error reporter. The app is used as
 * an installed PWA, which has no reachable devtools console, so this file is the only place a
 * frontend stack can be read after the fact.
 */
export const clientErrorLogPath = resolve(tmpdir(), 'agent-storm-client-errors.log');

/** Daemon entrypoint that `ensureDaemon` spawns when no daemon is alive on {@link daemonSocketPath}. */
export const daemonScriptPath = resolve(import.meta.dirname, 'daemon', 'pty-daemon.ts');

/** Where each queued PR gets a folder to be reviewed in, at `<owner>/<repo>/<PR number>`. */
export const reviewsDir = resolve(userDataDir, 'reviews');
/** Review folders get moved here to be deleted in the background. */
export const deletingReviewFoldersDir = resolve(userDataDir, 'deleting');
/**
 * The manual-review skill's folder. It holds the skill's {@link manualReviewStatePath} and the
 * copies `/manual-review here` makes of a checkout's branch, at `<main checkout's folder
 * name>/review__<branch>`.
 */
export const manualReviewSkillDir = resolve(userDataDir, 'manual-review');
/** Written by the manual-review skill, keyed by `<owner>/<repo>` then head branch. */
export const manualReviewStatePath = resolve(manualReviewSkillDir, 'state.json');

/** Which folders watch mode is on in, and where each one's watch stands. */
export const watchModeStatePath = resolve(userDataDir, 'watch-mode.json');

/** What watch mode's AI passes follow, pointed at from each pass's prompt. */
export const watchModeInstructionsPath = resolve(import.meta.dirname, 'watch-mode-instructions.md');

/** Each watched folder's latest pass: its tasks and PR check, for the AI to read. */
export const watchModePassDir = resolve(userDataDir, 'watch-mode');

/** User-level config file, managed via the settings modal. */
export const configPath = resolve(userDataDir, 'config.json');

/**
 * An AI running in a tab launches a session in another folder by moving a signed `<id>.json`
 * request into here, which `agentLaunchScriptPath` does for it. Kept on disk rather than behind an
 * endpoint so only this machine can make the request.
 */
export const agentLaunchRequestsDir = resolve(userDataDir, 'launch-requests');

/**
 * Signs and submits a launch request. Its path is given to every AI tab as
 * `AGENT_STORM_LAUNCH_SCRIPT`.
 */
export const agentLaunchScriptPath = resolve(import.meta.dirname, 'launch-session.script.ts');

/** The Review tab's settings, managed from its sidebar menus. */
export const reviewConfigPath = resolve(userDataDir, 'review-config.json');

/**
 * Where daily snapshots of {@link configPath} are written. Lives alongside the config (not in
 * `.not-committed/`, which is per-checkout) so backups survive a server reinstall as long as the
 * user's home directory is intact.
 */
export const configBackupDir = resolve(userDataDir, 'config-backups');

/** Directory where dragged-in screenshot uploads land before being attached to a pane. */
export const uploadsDir = resolve(tmpdir(), 'agent-storm-uploads');

/**
 * Avatar images for the user's AI definitions. Lives next to {@link configPath} rather than in
 * `tmpdir()` like {@link uploadsDir}: these are referenced by the config and have to survive a
 * reboot, while uploads are throwaway files handed to a terminal once.
 */
export const avatarsDir = resolve(userDataDir, 'avatars');

/**
 * Installed location of the Vir Icons VS Code extension, the source of truth for the Diff pane's
 * file-type icons. Only read by `generate-file-icons.script.ts`, which copies the icons it needs
 * into {@link fileIconsDir} so the app itself never depends on VS Code being installed.
 */
export const virIconsExtensionDir = resolve(homedir(), '.vscode', 'extensions', 'vir-icons');

/**
 * VS Code's bundled language extensions. An icon theme keys most of its common entries by language
 * id rather than by file extension, and these are what map one to the other, so
 * `generate-file-icons.script.ts` reads them to flatten `languageIds` down to extensions.
 */
export const vsCodeBundledExtensionsDir = resolve(
    '/Applications/downloaded/Visual Studio Code.app/Contents/Resources/app/extensions',
);

/** Where {@link virIconsExtensionDir}'s icons are copied to, for the frontend to fetch lazily. */
export const fileIconsDir = resolve(
    monorepoRoot,
    'packages',
    'frontend',
    'www-static',
    'file-icons',
);

/** Generated extension/filename to icon map that pairs with {@link fileIconsDir}. */
export const fileIconMapPath = resolve(
    monorepoRoot,
    'packages',
    'frontend',
    'src',
    'util',
    'file-icon-map.generated.ts',
);
