import {RepoInspectionState} from '@agent-storm/common';
import {convertRepoToWorktree, getConfig, inspectRepo, pickFolder, putConfig} from './api-client.js';

export type AddRepoOutcome =
    | {kind: 'added'; path: string}
    | {kind: 'already-added'; path: string}
    | {kind: 'cancelled'};

export type ConvertRepoConfirmRequest = {
    path: string;
    currentBranch: string;
    branchFolderName: string;
};

export type PickBaseBranchRequest = {
    path: string;
    branches: ReadonlyArray<string>;
};

export type ConfirmConvertRepoFn = (request: ConvertRepoConfirmRequest) => Promise<boolean>;
export type PickBaseBranchFn = (request: PickBaseBranchRequest) => Promise<string | undefined>;

/**
 * Picks a folder, inspects it, optionally converts a regular git repo to a worktree layout
 * (after caller-supplied confirmation), captures which branch is the "base branch" for this
 * repo, and registers the resulting worktree-root path in the config.
 *
 * The base branch is hidden from the sidebar and protected from deletion. For a freshly-converted
 * regular repo it's just the branch that was current at conversion time; for an already-worktree
 * repo we ask the caller (via `pickBaseBranch`) which existing branch should play that role.
 */
export async function addRepoFlow(
    confirmConvert: ConfirmConvertRepoFn,
    pickBaseBranch?: PickBaseBranchFn,
): Promise<AddRepoOutcome> {
    const picked = await pickFolder();
    if (!picked) {
        return {
kind: 'cancelled'
};
    }

    const config = await getConfig();
    const inspection = await inspectRepo(picked);

    // For a sub-worktree pick, the registerable repo path is the parent worktree-root and the
    // chosen base branch is the picked folder's own branch — no picker needed.
    const path =
        inspection.state === RepoInspectionState.WorktreeChild && inspection.worktreeRoot
            ? inspection.worktreeRoot
            : picked;

    if (config.repos.some((repo) => repo.path === path)) {
        return {
kind: 'already-added', path
};
    }

    if (inspection.state === RepoInspectionState.NotARepo) {
        throw new Error(`${picked} is not a git repository.`);
    } else if (inspection.state === RepoInspectionState.Empty) {
        throw new Error(`${picked} is empty. Initialize a git repository there first.`);
    }

    let baseBranch: string;

    if (inspection.state === RepoInspectionState.WorktreeChild) {
        if (!inspection.currentBranch) {
            throw new Error(
                `${picked} is a worktree but is on a detached HEAD. Check out a branch before adding it.`,
            );
        }
        baseBranch = inspection.currentBranch;
    } else if (inspection.state === RepoInspectionState.Regular) {
        if (!inspection.currentBranch) {
            throw new Error(
                `${path} is on a detached HEAD. Check out a branch before adding it.`,
            );
        } else if (!inspection.workingTreeClean) {
            throw new Error(
                `${path} has uncommitted changes or untracked files. Clean it up before converting to a worktree layout.`,
            );
        }
        const confirmed = await confirmConvert({
            path,
            currentBranch: inspection.currentBranch,
            branchFolderName: inspection.currentBranch.replace(/[/\\]/g, '-'),
        });
        if (!confirmed) {
            return {
kind: 'cancelled'
};
        }
        await convertRepoToWorktree(path);
        // The branch that was current at conversion time becomes the only existing worktree,
        // so it's the only sensible base.
        baseBranch = inspection.currentBranch;
    } else {
        if (inspection.branches.length === 0) {
            throw new Error(
                `${path} is a worktree-style repo but no worktree branches could be detected. Check out at least one branch as a worktree first.`,
            );
        }
        if (!pickBaseBranch) {
            throw new Error(
                `${path} is already a worktree-style repo and this caller didn't provide a base-branch picker. Add it from the Add Repo flow instead.`,
            );
        }
        const pickedBranch = await pickBaseBranch({
            path,
            branches: inspection.branches,
        });
        if (!pickedBranch) {
            return {
kind: 'cancelled'
};
        }
        baseBranch = pickedBranch;
    }

    await putConfig({
        ...config,
        repos: [
            ...config.repos,
            {
                path,
                postWorktreeCmd: null,
                baseBranch,
                // Server-side reconcile (runs on every config save) fills this in by
                // scanning the worktree-root for actual checkouts. Seed empty so the
                // shape validates; the first save round-trip populates it.
                worktrees: [],
                isWorktreeLayout: true,
            },
        ],
    });
    return {
kind: 'added', path
};
}
