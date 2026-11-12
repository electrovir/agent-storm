// cspell:words unpushed

import {PaneStatus, paneKindRunsAi, type FolderInfo, type PaneKind} from '@agent-storm/common';
import {extractErrorMessage, log, wait, wrapInTry} from '@augment-vir/common';
import {normalizePath, runCommand} from 'agent-storm';
import {type AnyDuration} from 'date-vir';
import {lstat} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {defineShape, parseJsonWithShape} from 'object-shape-tester';
import {killFolderPanes} from './daemon/daemon-client.js';
import {forgetFolderActivity} from './folder-activity.js';
import {getCachedFolders, refreshFolderInfoNow} from './folder-info.js';
import {
    getRepoSlug,
    gitTimeout,
    listWorktreeChildren,
    removeWorktree,
    runGh,
    tryGit,
} from './git.js';
import {findConversationTab, forgetFolderSessions, getFolderSessions} from './sessions.js';
import {deleteFolderState} from './ui-layout.js';

/**
 * Kills the folder's panes, removes the worktree, and forgets everything agent-storm kept about the
 * folder.
 */
export async function deleteWorktreeFolder(worktreePath: string) {
    await killFolderPanes({
        folder: worktreePath,
    }).catch(() => {
        /* if the daemon has no live panes for this folder, continue with deletion */
    });
    await wait({
        milliseconds: 250,
    });
    await removeWorktree({
        worktreePath,
    });
    /**
     * Drop the folder's session tabs now that the folder is gone. Worktree paths are derived
     * deterministically from the worktree name, so leaving them behind means a later worktree
     * created with the same name inherits this one's named, PTY-less tabs.
     */
    await forgetFolderSessions(worktreePath);
    forgetFolderActivity(worktreePath);
    await deleteFolderState(worktreePath);
    await refreshFolderInfoNow();
}

const branchPrsShape = defineShape([
    {
        number: 0,
        url: '',
        /** `OPEN`, `CLOSED`, or `MERGED`. */
        state: '',
        headRefOid: '',
    },
]);

export type BranchPr = (typeof branchPrsShape.runtimeType)[number];

const mergedPrState = 'MERGED';

/** What git says about a worktree's checkout. */
export type WorktreeGitState = {
    /** Undefined on a detached HEAD. */
    branch: string | undefined;
    tipOid: string;
    /** The branch `origin/HEAD` points at, without the `origin/` prefix. */
    defaultBranch: string | undefined;
    /** Whether the tip is reachable from `origin/<defaultBranch>`. */
    isMergedIntoDefault: boolean;
    /** `git status --porcelain` lines, untracked files included. */
    uncommittedFiles: string[];
    /** `<short hash> <subject>` of each commit no remote ref reaches. */
    unpushedCommits: string[];
    /** Another worktree that has `branch` checked out. */
    otherCheckoutPath: string | undefined;
};

function toLines(output: string | undefined) {
    return (output || '').split('\n').filter((line) => !!line.trim());
}

/** Paths of the worktrees that have `branch` checked out, from `git worktree list --porcelain`. */
async function findBranchCheckouts({
    cwd,
    branch,
}: Readonly<{
    cwd: string;
    branch: string;
}>): Promise<string[]> {
    const output = await tryGit(cwd, [
        'worktree',
        'list',
        '--porcelain',
    ]);
    const worktreePrefix = 'worktree ';
    return (output || '')
        .split('\n\n')
        .map((entry) => entry.split('\n'))
        .filter((lines) => lines.includes(`branch refs/heads/${branch}`))
        .map((lines) => {
            const pathLine = lines.find((line) => line.startsWith(worktreePrefix)) || '';
            return normalizePath(pathLine.slice(worktreePrefix.length));
        });
}

/**
 * Reads everything git knows about `folder`'s checkout, after fetching `origin` so that "pushed"
 * and "merged" are judged against the remote as it is now. A failed fetch (offline, no `origin`)
 * leaves the judgment to whatever was fetched last.
 */
export async function readWorktreeGitState(folder: string): Promise<WorktreeGitState> {
    await runCommand(
        'git',
        [
            'fetch',
            '--quiet',
            'origin',
        ],
        {
            cwd: folder,
            timeout: gitTimeout,
        },
    ).catch(() => undefined);
    const [
        branch,
        tipOid,
        originHead,
        status,
        unpushed,
    ] = await Promise.all([
        tryGit(folder, [
            'symbolic-ref',
            '--quiet',
            '--short',
            'HEAD',
        ]),
        tryGit(folder, [
            'rev-parse',
            'HEAD',
        ]),
        tryGit(folder, [
            'symbolic-ref',
            '--quiet',
            '--short',
            'refs/remotes/origin/HEAD',
        ]),
        tryGit(folder, [
            'status',
            '--porcelain=v1',
            '--untracked-files=all',
        ]),
        tryGit(folder, [
            'log',
            '--format=%h %s',
            'HEAD',
            '--not',
            '--remotes',
        ]),
    ]);
    const originPrefix = 'origin/';
    const trimmedOriginHead = originHead?.trim();
    const defaultBranch = trimmedOriginHead?.startsWith(originPrefix)
        ? trimmedOriginHead.slice(originPrefix.length)
        : undefined;
    const trimmedBranch = branch?.trim() || undefined;
    const isMergedIntoDefault =
        !!defaultBranch &&
        (await tryGit(folder, [
            'merge-base',
            '--is-ancestor',
            'HEAD',
            `refs/remotes/origin/${defaultBranch}`,
        ])) != undefined;
    const otherCheckoutPath = trimmedBranch
        ? (
              await findBranchCheckouts({
                  cwd: folder,
                  branch: trimmedBranch,
              })
          ).find((path) => path !== normalizePath(folder))
        : undefined;
    return {
        branch: trimmedBranch,
        tipOid: tipOid?.trim() || '',
        defaultBranch,
        isMergedIntoDefault,
        uncommittedFiles: toLines(status),
        unpushedCommits: toLines(unpushed),
        otherCheckoutPath,
    };
}

/** The branch's PRs on the folder's `origin` GitHub repo. Empty when there's no way to ask. */
async function fetchBranchPrs({
    folder,
    branch,
}: Readonly<{
    folder: string;
    branch: string;
}>): Promise<BranchPr[]> {
    const slug = await getRepoSlug(folder);
    if (!slug) {
        return [];
    }
    const result = await runGh([
        'pr',
        'list',
        '--repo',
        `${slug.owner}/${slug.name}`,
        '--head',
        branch,
        '--state',
        'all',
        '--limit',
        '20',
        '--json',
        'number,url,state,headRefOid',
    ]);
    if (result.exitCode !== 0) {
        return [];
    }
    return wrapInTry(() => parseJsonWithShape(result.stdout, branchPrsShape), {
        fallbackValue: [],
    });
}

/**
 * The PR that best describes the branch: a merged one whose head is the branch's tip, else an open
 * one, else the most recent.
 */
export function pickBranchPr({
    prs,
    tipOid,
}: Readonly<{
    prs: ReadonlyArray<Readonly<BranchPr>>;
    tipOid: string;
}>): BranchPr | undefined {
    return (
        prs.find((pr) => pr.state === mergedPrState && pr.headRefOid === tipOid) ||
        prs.find((pr) => pr.state === 'OPEN') ||
        prs[0]
    );
}

function isMergedAtTip({
    pr,
    tipOid,
}: Readonly<{
    pr: Readonly<BranchPr> | undefined;
    tipOid: string;
}>) {
    return !!pr && !!tipOid && pr.state === mergedPrState && pr.headRefOid === tipOid;
}

export type BranchDeletion = {
    willDelete: boolean;
    reason: string;
};

/**
 * Whether removing the worktree should also delete its local branch. Only when nothing on it can be
 * lost: it is merged into the default branch, or its PR merged with the branch's tip as its head
 * (which covers squash merges). Never the default branch or one checked out elsewhere.
 */
export function decideBranchDeletion({
    gitState: {branch, defaultBranch, tipOid, isMergedIntoDefault, otherCheckoutPath},
    pr,
}: Readonly<{
    gitState: Readonly<WorktreeGitState>;
    pr: Readonly<BranchPr> | undefined;
}>): BranchDeletion {
    if (!branch) {
        return {
            willDelete: false,
            reason: 'HEAD is detached, so there is no branch to delete.',
        };
    } else if (!defaultBranch) {
        return {
            willDelete: false,
            reason: 'Keeping the branch: could not tell the default branch, because origin/HEAD is not set.',
        };
    } else if (branch === defaultBranch) {
        return {
            willDelete: false,
            reason: `Keeping ${branch}: it is the default branch.`,
        };
    } else if (otherCheckoutPath) {
        return {
            willDelete: false,
            reason: `Keeping ${branch}: it is also checked out in ${otherCheckoutPath}.`,
        };
    } else if (isMergedIntoDefault) {
        return {
            willDelete: true,
            reason: `Deleting ${branch}: it is merged into origin/${defaultBranch}.`,
        };
    } else if (
        pr &&
        isMergedAtTip({
            pr,
            tipOid,
        })
    ) {
        return {
            willDelete: true,
            reason: `Deleting ${branch}: PR #${pr.number} merged, and its head is the branch's tip.`,
        };
    } else if (pr?.state === mergedPrState) {
        return {
            willDelete: false,
            reason: `Keeping ${branch}: PR #${pr.number} merged, but the branch has changed since.`,
        };
    } else {
        return {
            willDelete: false,
            reason: `Keeping ${branch}: it is not merged into origin/${defaultBranch} and has no merged PR.`,
        };
    }
}

/**
 * What removing the worktree would destroy. Unpushed commits don't count once a merged PR's head is
 * the branch's tip, since GitHub keeps them.
 */
export function findLostWork({
    gitState: {uncommittedFiles, unpushedCommits, tipOid},
    pr,
}: Readonly<{
    gitState: Readonly<WorktreeGitState>;
    pr: Readonly<BranchPr> | undefined;
}>): string[] {
    return [
        uncommittedFiles.length
            ? `${uncommittedFiles.length} uncommitted or untracked file(s).`
            : '',
        unpushedCommits.length &&
        !isMergedAtTip({
            pr,
            tipOid,
        })
            ? `${unpushedCommits.length} commit(s) that no remote has.`
            : '',
    ].filter((problem) => !!problem);
}

/**
 * Why `folder` is not a worktree that may be removed. Undefined when it is one: a linked worktree
 * directly inside a repo agent-storm lists, with a sibling left over after it goes.
 */
export async function findFolderRefusal({
    folder,
    info,
}: Readonly<{
    folder: string;
    info: Readonly<Pick<FolderInfo, 'parentRepoPath' | 'isWorktreeRoot'>> | undefined;
}>): Promise<string | undefined> {
    if (!info) {
        return `agent-storm does not list ${folder}.`;
    } else if (
        info.isWorktreeRoot ||
        !info.parentRepoPath ||
        normalizePath(dirname(folder)) !== normalizePath(info.parentRepoPath)
    ) {
        return `${folder} is not a worktree inside a repo agent-storm lists.`;
    }
    const dotGitStat = await lstat(join(folder, '.git')).catch(() => undefined);
    if (!dotGitStat?.isFile()) {
        return `${folder} is a main checkout, not a linked worktree.`;
    }
    const siblings = (await listWorktreeChildren(dirname(folder))).filter((path) => {
        return normalizePath(path) !== folder;
    });
    if (!siblings.length) {
        return `${folder} is the repo's last worktree.`;
    }
    return undefined;
}

export type FinishTab = {
    name: string;
    kind: PaneKind;
    isBusy: boolean;
};

export type FinishReport = {
    folder: string;
    branch: string | null;
    defaultBranch: string | null;
    pr: BranchPr | null;
    uncommittedFiles: string[];
    unpushedCommits: string[];
    /** What removing the worktree destroys. Removal needs `discard` when this isn't empty. */
    lostWork: string[];
    branchDeletion: BranchDeletion;
    /** Live tabs in the folder besides the requesting one, which removal closes. */
    otherTabs: FinishTab[];
    /** Why removal is refused even with `discard`. */
    blockers: string[];
};

/** A planned removal, with what's needed to carry it out. */
export type FinishPlan = {
    report: FinishReport;
    tipOid: string;
};

/** The live tabs in `folder` other than the requesting one. */
async function listOtherTabs({
    folder,
    info,
    requester,
}: Readonly<{
    folder: string;
    info: Readonly<Pick<FolderInfo, 'sessionStatuses'>>;
    requester: Readonly<{kind: PaneKind; sessionId: string}>;
}>): Promise<FinishTab[]> {
    const sessions = await getFolderSessions(folder);
    return info.sessionStatuses
        .filter((entry) => {
            return !(entry.kind === requester.kind && entry.sessionId === requester.sessionId);
        })
        .filter((entry) => entry.status !== PaneStatus.None && entry.status !== PaneStatus.Exited)
        .map((entry) => {
            const session = sessions[entry.kind].find((each) => each.id === entry.sessionId);
            return {
                name: session?.name || `${entry.kind} tab ${entry.sessionId}`,
                kind: entry.kind,
                isBusy: paneKindRunsAi[entry.kind] && entry.status === PaneStatus.Busy,
            };
        });
}

/**
 * Works out what removing the requesting tab's own worktree would do. Resolves to `{refusal}` when
 * the tab's folder isn't one that may be removed at all.
 */
export async function planFinish(
    conversationId: string,
): Promise<{refusal: string} | {plan: FinishPlan}> {
    const tab = await findConversationTab(conversationId);
    if (!tab) {
        return {
            refusal: 'agent-storm has no tab with this conversation id.',
        };
    }
    const folder = normalizePath(tab.folder);
    const info = (await getCachedFolders()).find((each) => each.path === folder);
    const folderRefusal = await findFolderRefusal({
        folder,
        info,
    });
    if (folderRefusal || !info) {
        return {
            refusal: folderRefusal || `agent-storm does not list ${folder}.`,
        };
    }
    const gitState = await readWorktreeGitState(folder);
    const pr = gitState.branch
        ? pickBranchPr({
              prs: await fetchBranchPrs({
                  folder,
                  branch: gitState.branch,
              }),
              tipOid: gitState.tipOid,
          })
        : undefined;
    const otherTabs = await listOtherTabs({
        folder,
        info,
        requester: {
            kind: tab.kind,
            sessionId: tab.session.id,
        },
    });
    const busyTabNames = otherTabs.filter((each) => each.isBusy).map((each) => each.name);
    const blockers = [
        gitState.branch && gitState.branch === gitState.defaultBranch
            ? `${folder} has the default branch (${gitState.branch}) checked out.`
            : '',
        gitState.tipOid ? '' : `${folder} has no commits git can read.`,
        busyTabNames.length
            ? `Another AI tab in this folder is still working: ${busyTabNames.join(', ')}.`
            : '',
    ].filter((blocker) => !!blocker);
    return {
        plan: {
            tipOid: gitState.tipOid,
            report: {
                folder,
                branch: gitState.branch ?? null,
                defaultBranch: gitState.defaultBranch ?? null,
                pr: pr ?? null,
                uncommittedFiles: gitState.uncommittedFiles,
                unpushedCommits: gitState.unpushedCommits,
                lostWork: findLostWork({
                    gitState,
                    pr,
                }),
                branchDeletion: decideBranchDeletion({
                    gitState,
                    pr,
                }),
                otherTabs,
                blockers,
            },
        },
    };
}

/**
 * Deletes `branch` from the repo `cwd` belongs to, but only if it still points at `tipOid` and no
 * worktree has it checked out. Resolves to what happened.
 */
export async function deleteBranchIfUnchanged({
    cwd,
    branch,
    tipOid,
}: Readonly<{
    cwd: string;
    branch: string;
    tipOid: string;
}>): Promise<string> {
    const currentOid = (
        await tryGit(cwd, [
            'rev-parse',
            '--verify',
            '--quiet',
            `refs/heads/${branch}`,
        ])
    )?.trim();
    if (currentOid !== tipOid) {
        return `Kept ${branch}: it moved to ${currentOid || 'nothing'} after the check.`;
    }
    const checkouts = await findBranchCheckouts({
        cwd,
        branch,
    });
    if (checkouts.length) {
        return `Kept ${branch}: it is checked out in ${checkouts.join(', ')}.`;
    }
    await runCommand(
        'git',
        [
            'branch',
            '-D',
            branch,
        ],
        {
            cwd,
            timeout: gitTimeout,
        },
    );
    return `Deleted ${branch} (was ${tipOid.slice(0, 12)}).`;
}

/**
 * How long removal waits after accepting, so the requesting tab can read the acceptance before its
 * pane is killed.
 */
const finishDelay: AnyDuration = {
    seconds: 1.5,
};

/** Removes the planned worktree and, when the plan says it is safe, deletes its branch. */
async function carryOutFinish({report, tipOid}: Readonly<FinishPlan>) {
    await wait(finishDelay);
    const sibling = (await listWorktreeChildren(dirname(report.folder))).find((path) => {
        return normalizePath(path) !== report.folder;
    });
    await deleteWorktreeFolder(report.folder);
    log.info(`Finished worktree ${report.folder}.`);
    if (report.branch && report.branchDeletion.willDelete && sibling) {
        log.info(
            await deleteBranchIfUnchanged({
                cwd: sibling,
                branch: report.branch,
                tipOid,
            }),
        );
    } else {
        log.info(report.branchDeletion.reason);
    }
}

export type FinishRequest = {
    conversationId: string;
    /** Only report what would happen. */
    isDryRun: boolean;
    /** Remove the worktree even though that destroys {@link FinishReport.lostWork}. */
    shouldDiscard: boolean;
};

/**
 * Handles a tab's request to remove its own worktree. Resolves once the request is accepted or
 * refused; an accepted removal happens afterwards, since it kills the requesting tab.
 */
export async function handleFinishRequest({
    conversationId,
    isDryRun,
    shouldDiscard,
}: Readonly<FinishRequest>): Promise<{refusal?: string; report?: FinishReport}> {
    const planned = await planFinish(conversationId);
    if ('refusal' in planned) {
        return {
            refusal: planned.refusal,
        };
    }
    const {report} = planned.plan;
    if (isDryRun) {
        return {
            report,
        };
    }
    const refusals = [
        ...report.blockers,
        ...(shouldDiscard ? [] : report.lostWork),
    ];
    if (refusals.length) {
        return {
            refusal: [
                'Refusing to remove the worktree:',
                ...refusals,
            ].join('\n'),
            report,
        };
    }
    carryOutFinish(planned.plan).catch((error: unknown) => {
        log.error(`Failed to finish worktree ${report.folder}: ${extractErrorMessage(error)}`);
    });
    return {
        report,
    };
}
