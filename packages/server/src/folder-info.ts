import {PaneKind, type Config, type FolderInfo, type PaneStatus} from '@agent-storm/common';
import {basename} from 'node:path';
import {getGitInfo, getPrInfo, isWorktreeRoot, listWorktreeChildren, type PrInfo} from './git.js';
import {getPaneStatusLookup} from './pty.js';

type PaneStatusLookup = (folder: string, kind: PaneKind) => PaneStatus;

const prCacheTtlMs = 60_000;

type PrCacheEntry = {
    fetchedAt: number;
    info: PrInfo | null;
};

const prCache = new Map<string, PrCacheEntry>();

async function getCachedPrInfo(folder: string, branch: string | null): Promise<PrInfo | null> {
    const key = `${folder}@${branch || ''}`;
    const existing = prCache.get(key);
    if (existing && Date.now() - existing.fetchedAt < prCacheTtlMs) {
        return existing.info;
    }
    const info = await getPrInfo(folder, branch);
    prCache.set(key, {
        fetchedAt: Date.now(),
        info,
    });
    return info;
}

async function buildFolderInfo({
    folder,
    parentRepoPath,
    isWorktreeRoot: isRoot,
    aiHidden,
    statusLookup,
}: Readonly<{
    folder: string;
    parentRepoPath: string | null;
    isWorktreeRoot: boolean;
    aiHidden: boolean;
    statusLookup: PaneStatusLookup;
}>): Promise<FolderInfo> {
    const git = await getGitInfo(folder);
    const pr = isRoot ? null : await getCachedPrInfo(folder, git.branch);
    return {
        path: folder,
        name: basename(folder),
        parentRepoPath,
        isWorktreeRoot: isRoot,
        aiHidden,
        branch: git.branch,
        git: {
            dirty: git.dirty,
            unpushed: git.unpushed,
        },
        prUrl: pr?.url || null,
        prMerged: !!pr?.merged,
        panes: {
            ai: statusLookup(folder, PaneKind.Ai),
            shell: statusLookup(folder, PaneKind.Shell),
        },
    };
}

export async function buildAllFolderInfo(config: Readonly<Config>): Promise<FolderInfo[]> {
    const statusLookup = await getPaneStatusLookup();
    const perRepo = await Promise.all(
        config.repos.map(async (repo) => {
            const isRoot = await isWorktreeRoot(repo.path);
            if (!isRoot) {
                return [
                    await buildFolderInfo({
                        folder: repo.path,
                        parentRepoPath: null,
                        isWorktreeRoot: false,
                        aiHidden: config.hiddenAiPane.includes(repo.path),
                        statusLookup,
                    }),
                ];
            }
            const children = await listWorktreeChildren(repo.path);
            const header = await buildFolderInfo({
                folder: repo.path,
                parentRepoPath: null,
                isWorktreeRoot: true,
                aiHidden: false,
                statusLookup,
            });
            const childInfos = await Promise.all(
                children.map((child) =>
                    buildFolderInfo({
                        folder: child,
                        parentRepoPath: repo.path,
                        isWorktreeRoot: false,
                        aiHidden: config.hiddenAiPane.includes(child),
                        statusLookup,
                    }),
                ),
            );
            return [
                header,
                ...childInfos,
            ];
        }),
    );
    return perRepo.flat();
}
