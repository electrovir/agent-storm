import {homedir, tmpdir} from 'node:os';
import {basename, resolve} from 'node:path';

export const monorepoRoot = resolve(import.meta.dirname, '..', '..', '..');

/** Git-ignored directory at the repo root for runtime secrets and on-disk caches. */
export const notCommittedDir = resolve(monorepoRoot, '.not-committed');

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

/** User-level config file, managed via the settings modal. */
export const configPath = resolve(homedir(), '.config', 'agent-storm.json');

/**
 * Where daily snapshots of {@link configPath} are written. Lives alongside the config (not in
 * `.not-committed/`, which is per-checkout) so backups survive a server reinstall as long as the
 * user's home directory is intact.
 */
export const configBackupDir = resolve(homedir(), '.config', 'agent-storm-backups');

/** Directory where dragged-in screenshot uploads land before being attached to a pane. */
export const uploadsDir = resolve(tmpdir(), 'agent-storm-uploads');

/**
 * Avatar images for the user's AI definitions. Lives next to {@link configPath} rather than in
 * `tmpdir()` like {@link uploadsDir}: these are referenced by the config and have to survive a
 * reboot, while uploads are throwaway files handed to a terminal once.
 */
export const avatarsDir = resolve(homedir(), '.config', 'agent-storm-avatars');

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
