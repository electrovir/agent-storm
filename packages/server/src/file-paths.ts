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

/** Unix domain socket the pty daemon listens on for new pane attachments. */
export const daemonSocketPath = resolve(tmpdir(), 'agent-storm-pty.sock');

/** Where the pty daemon's stdout/stderr is redirected (it runs detached from the server). */
export const daemonLogPath = resolve(tmpdir(), 'agent-storm-pty-daemon.log');

/** Daemon entrypoint that `ensureDaemon` spawns when no daemon is alive on {@link daemonSocketPath}. */
export const daemonScriptPath = resolve(import.meta.dirname, 'daemon', 'pty-daemon.ts');

/** User-level config file, managed via the settings modal. */
export const configPath = resolve(homedir(), '.config', 'agent-storm.json');

/** Directory where dragged-in screenshot uploads land before being attached to a pane. */
export const uploadsDir = resolve(tmpdir(), 'agent-storm-uploads');
