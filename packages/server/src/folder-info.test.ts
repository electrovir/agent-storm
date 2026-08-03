import {PaneKind, PaneStatus, type RepoConfig} from '@agent-storm/common';
import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {computeRepoPrRefreshTtlByRepo} from './folder-info.js';

const nowMs = 1_800_000_000_000;
const minuteMs = 60 * 1000;
const dayMs = 24 * 60 * minuteMs;

const hotTtlMs = 5 * minuteMs;
const coldTtlMs = 30 * minuteMs;

const repoPath = '/repos/solo';
const rootPath = '/repos/root';
const worktreePath = '/repos/root/branch-a';

/** No pane anywhere, which is the interesting case: every decision falls to config. */
const noLivePanes = () => PaneStatus.None;

const noPrHistory: ReadonlySet<string> = new Set();

function soloRepoTarget() {
    return {
        folder: repoPath,
        parentRepoPath: null,
        createdAtMs: 0,
        isWorktreeRoot: false,
        aiHidden: false,
        aiCmd: '',
        resetAiSessionCmd: '',
    };
}

function worktreeTargets() {
    return [
        {
            folder: rootPath,
            parentRepoPath: null,
            createdAtMs: 0,
            isWorktreeRoot: true,
            aiHidden: false,
            aiCmd: '',
            resetAiSessionCmd: '',
        },
        {
            folder: worktreePath,
            parentRepoPath: rootPath,
            createdAtMs: 0,
            isWorktreeRoot: false,
            aiHidden: false,
            aiCmd: '',
            resetAiSessionCmd: '',
        },
    ];
}

function repoConfig(lastInteractedAtMs: number): RepoConfig {
    return {
        path: repoPath,
        postWorktreeCmd: null,
        lastInteractedAtMs,
    };
}

/** Untouched for two months — inactive by every measure. */
const staleRepoConfig = repoConfig(nowMs - 60 * dayMs);

describe(computeRepoPrRefreshTtlByRepo.name, () => {
    it('skips a plain repo with no worktrees that has never shown a PR', () => {
        const ttlByRepo = computeRepoPrRefreshTtlByRepo({
            targets: [soloRepoTarget()],
            statusLookup: noLivePanes,
            repos: [staleRepoConfig],
            onlyShowRecent: false,
            everHadPrPaths: noPrHistory,
            nowMs,
        });
        assert.isUndefined(ttlByRepo.get(repoPath));
    });

    it('polls that same repo once it has shown a PR before', () => {
        const ttlByRepo = computeRepoPrRefreshTtlByRepo({
            targets: [soloRepoTarget()],
            statusLookup: noLivePanes,
            repos: [staleRepoConfig],
            onlyShowRecent: false,
            everHadPrPaths: new Set([repoPath]),
            nowMs,
        });
        assert.strictEquals(ttlByRepo.get(repoPath), coldTtlMs);
    });

    it('polls a never-PR repo while it is active, so a first PR can be discovered', () => {
        const ttlByRepo = computeRepoPrRefreshTtlByRepo({
            targets: [soloRepoTarget()],
            statusLookup: (folder, kind) =>
                folder === repoPath && kind === PaneKind.Ai ? PaneStatus.Idle : PaneStatus.None,
            repos: [staleRepoConfig],
            onlyShowRecent: false,
            everHadPrPaths: noPrHistory,
            nowMs,
        });
        assert.strictEquals(ttlByRepo.get(repoPath), hotTtlMs);
    });

    it('treats a recent activation as active even with no pane running', () => {
        const ttlByRepo = computeRepoPrRefreshTtlByRepo({
            targets: [soloRepoTarget()],
            statusLookup: noLivePanes,
            repos: [repoConfig(nowMs - 2 * minuteMs)],
            onlyShowRecent: false,
            everHadPrPaths: noPrHistory,
            nowMs,
        });
        assert.strictEquals(ttlByRepo.get(repoPath), hotTtlMs);
    });

    it('polls a worktree group that has never shown a PR', () => {
        const ttlByRepo = computeRepoPrRefreshTtlByRepo({
            targets: worktreeTargets(),
            statusLookup: noLivePanes,
            repos: [],
            onlyShowRecent: true,
            everHadPrPaths: noPrHistory,
            nowMs,
        });
        assert.deepEquals(Array.from(ttlByRepo.entries()), [
            [
                rootPath,
                coldTtlMs,
            ],
        ]);
    });

    it('makes a whole worktree group hot when any one of its folders is live', () => {
        const ttlByRepo = computeRepoPrRefreshTtlByRepo({
            targets: worktreeTargets(),
            statusLookup: (folder) => (folder === worktreePath ? PaneStatus.Busy : PaneStatus.None),
            repos: [],
            onlyShowRecent: false,
            everHadPrPaths: noPrHistory,
            nowMs,
        });
        assert.strictEquals(ttlByRepo.get(rootPath), hotTtlMs);
    });

    it('skips a PR-having repo that the sidebar is hiding', () => {
        const ttlByRepo = computeRepoPrRefreshTtlByRepo({
            targets: [soloRepoTarget()],
            statusLookup: noLivePanes,
            repos: [staleRepoConfig],
            onlyShowRecent: true,
            everHadPrPaths: new Set([repoPath]),
            nowMs,
        });
        assert.isUndefined(ttlByRepo.get(repoPath));
    });
});
