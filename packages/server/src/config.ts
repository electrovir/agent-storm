import {defaultConfig, type Config} from '@agent-storm/common';
import {type ArrayElement} from '@augment-vir/common';
import {randomBytes} from 'node:crypto';
import {mkdir, readFile, rename, stat, unlink, writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';
import {configPath} from './file-paths.js';
import {normalizePath} from './paths.js';

/**
 * Serialises overlapping `saveConfig` calls so two concurrent writers can't race on the same
 * file. Each call awaits the previous one's full write-and-rename sequence before starting its
 * own. Combined with the atomic rename in `saveConfig` below, this gives both intra-process
 * (multiple endpoints in flight) and inter-process (multiple backends — should be impossible
 * now that ports are fixed, but defence in depth) safety: the worst case is one writer's
 * intent gets overwritten by another, never a malformed JSON file.
 */
let writeChain: Promise<void> = Promise.resolve();


function normalizeConfig(config: Readonly<Config>): Config {
    return {
        ...config,
        repos: config.repos.map((repo) => ({
            ...repo,
            path: normalizePath(repo.path),
            // Legacy configs predate `worktrees` / `isWorktreeLayout`; fill in defaults so the
            // reconcile step can populate them on first load instead of crashing on undefined.
            worktrees: (repo.worktrees ?? []).map((worktree) => ({
                ...worktree,
                path: normalizePath(worktree.path),
                lastReviewedSha: worktree.lastReviewedSha ?? null,
                mergeStepValues: worktree.mergeStepValues ?? {},
            })),
            isWorktreeLayout: repo.isWorktreeLayout ?? false,
        })),
        /**
         * Keep an entry if it contributes at least one override — either an AI command or a
         * reset-AI-session command. Entries with both empty are dead weight and would otherwise
         * accumulate as users toggle settings on and off.
         */
        folderAiCmds: config.folderAiCmds
            .filter((entry) => entry.aiCmd.trim() || entry.resetAiSessionCmd?.trim())
            .map((entry) => {
                const resetCmd = entry.resetAiSessionCmd?.trim() || undefined;
                return {
                    folder: normalizePath(entry.folder),
                    aiCmd: entry.aiCmd.trim(),
                    ...(resetCmd
                        ? {
                              resetAiSessionCmd: resetCmd,
                          }
                        : {}),
                };
            }),
        hiddenAiPane: config.hiddenAiPane.map((path) => normalizePath(path)),
        hiddenWorktrees: (config.hiddenWorktrees ?? []).map((path) => normalizePath(path)),
        doLaterFolders: (config.doLaterFolders ?? []).map((path) => normalizePath(path)),
    };
}

export function getFolderAiCmd({
    config,
    folder,
    fallbackFolders = [],
}: Readonly<{
    config: Config;
    folder: string;
    fallbackFolders?: ReadonlyArray<string> | undefined;
}>): string {
    const folderCandidates = [
        normalizePath(folder),
        ...fallbackFolders.map((fallbackFolder) => normalizePath(fallbackFolder)),
    ];
    const matchingOverride = folderCandidates.reduce<
        ArrayElement<typeof config.folderAiCmds> | undefined
    >(
        (found, candidate) =>
            found || config.folderAiCmds.find((entry) => entry.folder === candidate),
        undefined,
    );
    return matchingOverride?.aiCmd || config.aiCmd;
}

export function setFolderAiCmd({
    config,
    folder,
    aiCmd,
}: Readonly<{
    config: Config;
    folder: string;
    aiCmd: string;
}>): Config {
    const normalizedFolder = normalizePath(folder);
    const trimmedAiCmd = aiCmd.trim();
    const existing = config.folderAiCmds.find((entry) => entry.folder === normalizedFolder);
    const otherFolderAiCmds = config.folderAiCmds.filter(
        (entry) => entry.folder !== normalizedFolder,
    );
    /**
     * Preserve any existing reset-AI-session override on this folder when only the AI command is
     * being edited — clearing the AI cmd shouldn't silently drop a sibling reset-cmd override.
     */
    const preservedReset = existing?.resetAiSessionCmd?.trim();
    const aiCmdIsOverride = trimmedAiCmd && trimmedAiCmd !== config.aiCmd;
    return normalizeConfig({
        ...config,
        folderAiCmds:
            aiCmdIsOverride || preservedReset
                ? [
                      ...otherFolderAiCmds,
                      {
                          folder: normalizedFolder,
                          aiCmd: aiCmdIsOverride ? trimmedAiCmd : '',
                          ...(preservedReset
                              ? {
                                    resetAiSessionCmd: preservedReset,
                                }
                              : {}),
                      },
                  ]
                : otherFolderAiCmds,
    });
}

/**
 * Compute the folder-effective "Restart AI session" command, walking the same per-folder →
 * fallback-folder → global default chain {@link getFolderAiCmd} uses. Returns an empty string when
 * neither the folder nor any fallback nor the global default has a non-empty value; callers
 * (sidebar UI, `/panes/reset-ai-session` endpoint) treat empty as "command not configured" and skip
 * the action / hide the menu item.
 */
export function getFolderResetAiSessionCmd({
    config,
    folder,
    fallbackFolders = [],
}: Readonly<{
    config: Config;
    folder: string;
    fallbackFolders?: ReadonlyArray<string> | undefined;
}>): string {
    const folderCandidates = [
        normalizePath(folder),
        ...fallbackFolders.map((fallbackFolder) => normalizePath(fallbackFolder)),
    ];
    const matchingOverride = folderCandidates.reduce<
        ArrayElement<typeof config.folderAiCmds> | undefined
    >(
        (found, candidate) =>
            found || config.folderAiCmds.find((entry) => entry.folder === candidate),
        undefined,
    );
    return matchingOverride?.resetAiSessionCmd?.trim() || config.resetAiSessionCmd || '';
}

/**
 * Per-folder setter for the reset-AI-session command. Mirrors {@link setFolderAiCmd}: a trimmed,
 * different-from-global value writes/upserts the override entry; matching the global (or empty)
 * removes the override field and prunes the entry if no other override remains on the same folder.
 */
export function setFolderResetAiSessionCmd({
    config,
    folder,
    resetAiSessionCmd,
}: Readonly<{
    config: Config;
    folder: string;
    resetAiSessionCmd: string;
}>): Config {
    const normalizedFolder = normalizePath(folder);
    const trimmedReset = resetAiSessionCmd.trim();
    const existing = config.folderAiCmds.find((entry) => entry.folder === normalizedFolder);
    const otherFolderAiCmds = config.folderAiCmds.filter(
        (entry) => entry.folder !== normalizedFolder,
    );
    const preservedAiCmd = existing?.aiCmd.trim();
    const resetIsOverride = trimmedReset && trimmedReset !== config.resetAiSessionCmd;
    return normalizeConfig({
        ...config,
        folderAiCmds:
            resetIsOverride || preservedAiCmd
                ? [
                      ...otherFolderAiCmds,
                      {
                          folder: normalizedFolder,
                          aiCmd: preservedAiCmd || '',
                          ...(resetIsOverride
                              ? {
                                    resetAiSessionCmd: trimmedReset,
                                }
                              : {}),
                      },
                  ]
                : otherFolderAiCmds,
    });
}

export async function loadConfig(): Promise<Config> {
    /**
     * Use `stat` to distinguish "file doesn't exist yet" from any other read failure. The old code
     * collapsed both into "save defaults", which meant a transient read error (or — worse — a brief
     * empty-file window caused by a non-atomic `writeFile`) would silently overwrite the user's
     * config with defaults. Now we ONLY auto-create the file on a true `ENOENT`. Anything else
     * (read failure, empty file, JSON parse error) throws and the caller decides what to do —
     * load-modify-save callers catch and skip their save so the existing file is preserved.
     */
    const exists = await stat(configPath)
        .then(() => true)
        .catch(() => false);
    if (!exists) {
        await saveConfig(defaultConfig);
        return defaultConfig;
    }
    const contents = await readFile(configPath, 'utf-8');
    if (!contents.trim()) {
        throw new Error(
            `Config file at ${configPath} exists but is empty; refusing to overwrite with defaults.`,
        );
    }
    let parsed: Partial<Config>;
    try {
        parsed = JSON.parse(contents) as Partial<Config>;
    } catch (error) {
        /**
         * Corrupt config — most plausibly from a concurrent-write race during the period before
         * `saveConfig` was atomic. We back up the bad bytes (so the user can recover their repo
         * list manually if needed) and fall back to defaults rather than crashing every
         * endpoint that calls loadConfig until someone hand-edits the file. saveConfig is now
         * atomic via temp+rename and serialised through `writeChain`, so this shouldn't recur.
         */
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupPath = `${configPath}.corrupt-${stamp}.bak`;
        await writeFile(backupPath, contents, 'utf-8').catch(() => {
            /* backup is best-effort — don't block recovery on it */
        });
        console.error(
            `agent-storm: config at ${configPath} is corrupt (${
                error instanceof Error ? error.message : String(error)
            }). Backed up to ${backupPath} and starting from defaults.`,
        );
        await saveConfig(defaultConfig);
        return defaultConfig;
    }
    const merged: Config = {
        ...defaultConfig,
        ...parsed,
        repos: parsed.repos || defaultConfig.repos,
        folderAiCmds: parsed.folderAiCmds || defaultConfig.folderAiCmds,
        hiddenAiPane: parsed.hiddenAiPane || defaultConfig.hiddenAiPane,
        hiddenWorktrees: parsed.hiddenWorktrees || defaultConfig.hiddenWorktrees,
        doLaterFolders: parsed.doLaterFolders || defaultConfig.doLaterFolders,
    };
    return normalizeConfig(merged);
}

/**
 * Write the config atomically: stage to a temp file inside the same directory as the target, then
 * `rename` over the destination. `rename` is atomic on POSIX (and on macOS) when both paths are on
 * the same filesystem — readers either see the prior version or the new version, never an empty or
 * partially-written file. This eliminates the empty-file race that previously caused concurrent
 * `loadConfig` calls (from `/repos/touch`, GitHub-polling auto-disable, etc.) to fall through to
 * the "save defaults" path and wipe the user's settings.
 */
export async function saveConfig(config: Readonly<Config>): Promise<void> {
    // Chain onto any in-flight write so concurrent callers serialise instead of racing. The
    // chained-promise pattern keeps `saveConfig` non-blocking from the endpoint's perspective
    // (callers still get a single Promise to await) while guaranteeing FIFO ordering of the
    // underlying disk writes.
    const next = writeChain.then(() => writeConfigAtomic(config));
    writeChain = next.catch(() => {
        /* swallow so a failed write doesn't poison the chain for subsequent saves */
    });
    await next;
}

async function writeConfigAtomic(config: Readonly<Config>): Promise<void> {
    await mkdir(dirname(configPath), {recursive: true});
    const normalized = normalizeConfig(config);
    const body = JSON.stringify(normalized, undefined, 4);
    /**
     * Write to a sibling tmp file then `rename(tmp, configPath)` — POSIX `rename` is atomic
     * on the same filesystem, so a reader will either see the old complete file or the new
     * complete file, never a half-written one. The unique suffix prevents collision if a
     * second writer slips past the `writeChain` (e.g. across processes); the loser's tmp
     * file is cleaned up below.
     */
    const tmpPath = `${configPath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    try {
        await writeFile(tmpPath, body, {encoding: 'utf-8', mode: 0o600});
        await rename(tmpPath, configPath);
    } catch (error) {
        await unlink(tmpPath).catch(() => {
            /* tmp file may not exist if writeFile itself failed — non-fatal */
        });
        throw error;
    }
}
