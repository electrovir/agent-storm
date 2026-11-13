import {replaceExtension} from '@augment-vir/common';
import {currentOperatingSystem, OperatingSystem} from '@augment-vir/node';
import {builtInPluginBuildDirName, ReleaseDir} from 'agent-storm';
import {instanceName, instanceSuffix, userDataDir} from 'agent-storm-util';
import {homedir, tmpdir} from 'node:os';
import {basename, resolve} from 'node:path';
import {releaseBuild} from './release-build.js';

export const monorepoRoot = resolve(import.meta.dirname, '..', '..', '..');

/** Git-ignored directory at the repo root for runtime secrets and on-disk caches. */
export const notCommittedDir = resolve(monorepoRoot, '.not-committed');

/** Run with Node directly rather than through `npx`: Windows can't spawn `npx` without a shell. */
export const runstormCliPath = resolve(
    monorepoRoot,
    'node_modules',
    'runstorm',
    'dist',
    'cli',
    'cli.script.js',
);

export const nodePtyPrebuildsDir = resolve(monorepoRoot, 'node_modules', 'node-pty', 'prebuilds');

/** The top folder of a release, which holds its `server/` and `frontend/` folders. */
export const releaseRootDir = resolve(import.meta.dirname, '..');

/** The launcher bundled beside a release's server. Only a release has it. */
export const releaseLauncherPath = resolve(import.meta.dirname, 'launcher.js');

/**
 * This instance's files inside {@link notCommittedDir}. Two instances run from one checkout must not
 * share pane sessions or caches, so a named instance gets a subdirectory.
 */
const checkoutStateDir = instanceName
    ? resolve(notCommittedDir, 'instances', instanceName)
    : notCommittedDir;

/**
 * The server's own files: its auth secret and on-disk caches. A release keeps them in
 * {@link userDataDir} so they outlive switching to another release.
 */
export const serverStateDir = releaseBuild
    ? resolve(userDataDir, 'server-state')
    : checkoutStateDir;

/**
 * Argon2id hash of the bearer secret used for browser ↔ backend auth. Only the hash is stored on
 * disk; the cleartext is shown once at startup and is required by the client.
 */
export const authSecretPath = resolve(serverStateDir, 'auth-secret');

/**
 * Filename portion of {@link authSecretPath}, used to filter `fs.watch` events on
 * {@link serverStateDir} (the watcher delivers basenames, not full paths).
 */
export const authSecretFileName = basename(authSecretPath);

/**
 * Persisted folder-info cache so the sidebar reappears with last-known git/PR/pane state on server
 * restart instead of waiting a full sweep cycle to repopulate.
 */
export const folderInfoCachePath = resolve(serverStateDir, 'folder-info-cache.json');

/**
 * Persisted GitHub PR cache + auto-disable state. Survives server restarts so `tsx --watch` reloads
 * during dev don't blow away the 10-minute PR cache and trigger a fresh round of GraphQL fetches on
 * every file save, and so a rate-limit/auth auto-disable sticks until its expiry rather than
 * resetting on every restart.
 */
export const githubCachePath = resolve(serverStateDir, 'github-cache.json');

/**
 * Per-folder session tab lists (order + user-assigned names) for each pane kind. Lives here rather
 * than in {@link settingsJsonPath} because it's app state, not a hand-editable setting — but it
 * still has to survive daemon and server restarts, since a tab name the user typed can't be
 * regenerated the way git or PR state can.
 */
export const sessionStorePath = resolve(userDataDir, 'folder-state', 'pane-sessions.json');
/** The AI tabs that were in the middle of a task when last checked, to resume after a reboot. */
export const livePanesPath = resolve(userDataDir, 'folder-state', 'live-panes.json');
/** Where {@link sessionStorePath} was kept before it moved, read only to migrate it. */
export const legacySessionStorePath = resolve(checkoutStateDir, 'pane-sessions.json');

/**
 * Per-folder timestamp of the last keystroke the user sent to one of that folder's panes, backing
 * the sidebar's "Sort by activity" option. Persisted because the ordering it produces is only
 * useful if it spans the days the user has been working, not the current server process.
 */
export const folderActivityPath = resolve(userDataDir, 'folder-state', 'folder-activity.json');
/** Where {@link folderActivityPath} was kept before it moved, read only to migrate it. */
export const legacyFolderActivityPath = resolve(checkoutStateDir, 'folder-activity.json');

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

const unixDaemonSocket = {
    path: resolve(tmpdir(), `agent-storm${instanceSuffix}-pty.sock`),
    isFile: true,
};

/**
 * Where the pty daemon listens for new pane attachments. A Unix socket is a file that outlives a
 * crashed daemon; a Windows named pipe disappears with the process that owns it.
 */
export const daemonSocket = (
    {
        [OperatingSystem.Mac]: unixDaemonSocket,
        [OperatingSystem.Linux]: unixDaemonSocket,
        [OperatingSystem.Windows]: {
            path: String.raw`\\.\pipe\agent-storm${instanceSuffix}-pty`,
            isFile: false,
        },
    } satisfies Record<OperatingSystem, {path: string; isFile: boolean}>
)[currentOperatingSystem];

/** Where the pty daemon's stdout/stderr is redirected (it runs detached from the server). */
export const daemonLogPath = resolve(tmpdir(), `agent-storm${instanceSuffix}-pty-daemon.log`);

/**
 * Mirror of the backend's stdout/stderr written from `index.ts`. Lets the assistant tail a file
 * instead of asking the user to copy/paste console output, especially when debugging WS / proxy
 * flows where the relevant log lines are dense and time-ordered.
 */
export const serverLogPath = resolve(tmpdir(), `agent-storm${instanceSuffix}-server.log`);

/**
 * Browser-side errors, shipped to the backend by the frontend's error reporter. The app is used as
 * an installed PWA, which has no reachable devtools console, so this file is the only place a
 * frontend stack can be read after the fact.
 */
export const clientErrorLogPath = resolve(
    tmpdir(),
    `agent-storm${instanceSuffix}-client-errors.log`,
);

/**
 * Debug entries shipped by the frontend, one JSON object per line, in one file per UTC hour. Files
 * older than a day are deleted, so search them all with `cat <dir>/*.jsonl | jq ...` and never
 * clean up by hand.
 */
export const debugLogDir = resolve(tmpdir(), `agent-storm${instanceSuffix}-debug-logs`);

/**
 * One JSON object per line from both sides: the browser's slow windows (`side: 'client'`) and the
 * server's slow windows and startups (`side: 'server'`). The PWA has no devtools to profile in, so
 * this file is where a slowdown gets diagnosed.
 */
export const perfLogPath = resolve(tmpdir(), `agent-storm${instanceSuffix}-perf.log`);

/**
 * A script the server spawns, from its source path. A release bundles each one into a `.js` file of
 * the same name beside the server's own bundle.
 */
function toSpawnedScriptPath(sourcePath: string) {
    return releaseBuild
        ? resolve(
              import.meta.dirname,
              replaceExtension({
                  path: basename(sourcePath),
                  newExtension: '.js',
              }),
          )
        : sourcePath;
}

/** Daemon entrypoint that `ensureDaemon` spawns when no daemon is alive on {@link daemonSocket}. */
export const daemonScriptPath = toSpawnedScriptPath(
    resolve(import.meta.dirname, 'daemon', 'pty-daemon.ts'),
);

/**
 * Where review folders were kept before they moved into the manual-review skill's folder,
 * `manualReviewSkillDir`.
 */
export const legacyReviewsDir = resolve(userDataDir, 'reviews');

/**
 * The user's settings file, managed via the settings modal. It may also be YAML, TOML, or TS until
 * the modal first saves it.
 */
export const settingsJsonPath = resolve(userDataDir, 'settings.json');

/** The app's own state, such as the repo list, kept apart from the user's settings. */
export const appStatePath = resolve(userDataDir, 'state.json');

/** Each folder (or symlink to one) in here is an external plugin. */
export const pluginsDir = resolve(userDataDir, 'plugins');

/** Held both settings and app state before they were split. Migrated once on startup. */
export const legacyConfigPath = resolve(userDataDir, 'config.json');

/**
 * Text that failed to reach a pane, such as a review verdict, one JSON object per line, so it can
 * be sent again by hand. Kept in {@link userDataDir} since the server log is wiped on every
 * restart.
 */
export const failedPaneInputsPath = resolve(userDataDir, 'failed-pane-inputs.jsonl');

/**
 * An AI running in a tab launches a session in another folder by moving a signed `<id>.json`
 * request into here, which `agentLaunchScriptPath` does for it. Kept on disk rather than behind an
 * endpoint so only this machine can make the request.
 */
export const agentLaunchRequestsDir = resolve(userDataDir, 'launch-requests');

/**
 * Signs and submits a launch request. Its path is given to every tab as
 * `AGENT_STORM_LAUNCH_SCRIPT`.
 */
export const agentLaunchScriptPath = toSpawnedScriptPath(
    resolve(import.meta.dirname, 'launch-session.script.ts'),
);

/** A release's built frontend, which its server serves. */
export const releaseFrontendDir = resolve(import.meta.dirname, '..', ReleaseDir.Frontend);

/** The folder a built-in plugin's manifest and bundles are in. */
export function findBuiltInPluginDir(pluginId: string) {
    return releaseBuild
        ? resolve(import.meta.dirname, '..', ReleaseDir.Plugins, pluginId)
        : resolve(monorepoRoot, 'packages', `plugin-${pluginId}`, builtInPluginBuildDirName);
}

/** Each plugin's own folder of files it keeps, by plugin id. */
export const pluginDataDir = resolve(userDataDir, 'plugin-data');

/** Each plugin's own folder of throwaway files, by plugin id. */
export const pluginTempDir = resolve(tmpdir(), `agent-storm${instanceSuffix}-plugins`);

/** Held the Review tab's settings before they moved into the settings file. */
export const legacyReviewConfigPath = resolve(userDataDir, 'review-config.json');

/** The main tab order, shared by every window. */
export const uiLayoutPath = resolve(userDataDir, 'ui-layout.json');
/** Each folder's UI state, one directory per folder, deleted with the folder. */
export const folderStatesDir = resolve(userDataDir, 'folders');

/**
 * Where daily snapshots of the user's settings file are written. Lives alongside the config (not in
 * `.not-committed/`, which is per-checkout) so backups survive a server reinstall as long as the
 * user's home directory is intact.
 */
export const configBackupDir = resolve(userDataDir, 'config-backups');

/**
 * Avatar images for the user's AI definitions. Lives next to {@link settingsJsonPath} rather than in
 * `tmpdir()` like terminal uploads: these are referenced by the config and have to survive a
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
    'plugin-diff',
    'src',
    'util',
    'file-icon-map.generated.ts',
);
