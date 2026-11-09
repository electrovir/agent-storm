import {type FolderInfo} from '@agent-storm/common';
import {type FolderDataObservable} from '@agent-storm/core/frontend';

/**
 * The folder the Build activity's segments select, or `isInvalid` when the URL can't be valid given
 * the current folder list (e.g. `/build/<repoName>` where that repo has worktrees, or
 * `/build/<repoName>/<worktreeName>` where neither exists).
 */
export function resolveBuildFolder(
    subPaths: ReadonlyArray<string>,
    folderInfo: ReadonlyMap<string, FolderInfo>,
) {
    /**
     * Bail before folder info has loaded so we don't redirect a URL that might be perfectly valid
     * once data arrives.
     */
    if (subPaths.length === 0 || folderInfo.size === 0) {
        return {
            folder: undefined,
            isInvalid: false,
        };
    }
    const [
        repoName,
        worktreeName,
    ] = subPaths;
    const folders = Array.from(folderInfo.values());
    if (!worktreeName) {
        /**
         * Single-segment URL: only valid if it matches a standalone (non-worktree-root, no-parent)
         * repo. Worktree-root matches are explicitly invalid per the route spec — the user must
         * pick a worktree segment.
         */
        const standalone = folders.find((folder) => {
            return folder.name === repoName && !folder.isWorktreeRoot && !folder.parentRepoPath;
        });
        return {
            folder: standalone,
            isInvalid: !standalone,
        };
    }
    const repoRoot = folders.find((folder) => folder.name === repoName && folder.isWorktreeRoot);
    const worktree =
        repoRoot &&
        folders.find(
            (folder) => folder.parentRepoPath === repoRoot.path && folder.name === worktreeName,
        );
    return {
        folder: worktree,
        isInvalid: !worktree,
    };
}

/**
 * The Build activity's segments that select `folder`.
 *
 * - Standalone repo → `[folder.name]`.
 * - Worktree child → `[parentRepoName, folder.name]` (we resolve the parent's name through
 *   `folderInfo`; falls back to its basename via `parentRepoPath` if for some reason the parent
 *   isn't in the map).
 * - Worktree root → `[folder.name]` (the activation path for worktree-roots is "user clicked a
 *   child", so this branch is mostly defensive; if it ever fires the redirect-to-root logic above
 *   will undo it on the next render).
 */
export function subPathsForFolder(
    folder: Readonly<FolderInfo>,
    folderInfo: ReadonlyMap<string, FolderInfo>,
) {
    if (folder.parentRepoPath) {
        const parent = folderInfo.get(folder.parentRepoPath);
        const parentName = parent?.name || folder.parentRepoPath.split('/').findLast(Boolean);
        return [
            parentName || folder.parentRepoPath,
            folder.name,
        ];
    }
    return [
        folder.name,
    ];
}

/**
 * Routes to the folder an AI asks to switch to. Only the visible tab follows, so a background tab
 * doesn't change under the user, and only once per request, so the user can switch away. Returns
 * the listener's remover.
 */
export function followFolderActivations({
    folderData,
    navigate,
}: Readonly<{
    folderData: Readonly<Pick<FolderDataObservable, 'listen'>>;
    navigate(subPaths: ReadonlyArray<string>): void;
}>): () => void {
    const followed: {
        requestId: string | undefined;
    } = {
        requestId: undefined,
    };
    return folderData.listen(true, ({live, folderInfo}) => {
        const folderActivation = live?.listing.folderActivation;
        const folder = folderActivation && folderInfo.get(folderActivation.folder);
        if (
            folderActivation &&
            folder &&
            folderActivation.requestId !== followed.requestId &&
            document.visibilityState === 'visible'
        ) {
            followed.requestId = folderActivation.requestId;
            navigate(subPathsForFolder(folder, folderInfo));
        }
    });
}
