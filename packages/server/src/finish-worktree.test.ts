// cspell:words unpushed

import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {normalizePath} from 'agent-storm';
import {execFile} from 'node:child_process';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {
    decideBranchDeletion,
    deleteBranchIfUnchanged,
    findFolderRefusal,
    findLostWork,
    pickBranchPr,
    readWorktreeGitState,
    type BranchPr,
    type WorktreeGitState,
} from './finish-worktree.js';

const exec = promisify(execFile);

async function git(cwd: string, args: ReadonlyArray<string>) {
    return (
        await exec('git', [...args], {
            cwd,
        })
    ).stdout.trim();
}

const tipOid = 'a'.repeat(40);

function gitState(overrides: Readonly<Partial<WorktreeGitState>>): WorktreeGitState {
    return {
        branch: 'feature',
        tipOid,
        defaultBranch: 'main',
        isMergedIntoDefault: false,
        uncommittedFiles: [],
        unpushedCommits: [],
        otherCheckoutPath: undefined,
        ...overrides,
    };
}

function branchPr(overrides: Readonly<Partial<BranchPr>>): BranchPr {
    return {
        number: 7,
        url: 'https://github.com/owner/name/pull/7',
        state: 'OPEN',
        headRefOid: tipOid,
        ...overrides,
    };
}

/**
 * A repo laid out the way agent-storm lists one: `parent` holds the main checkout `main` (cloned
 * from a bare `origin`, with `origin/HEAD` set) and a linked worktree `feature` on branch
 * `feature`.
 */
async function withRepo(
    run: (
        paths: Readonly<{parent: string; mainPath: string; featurePath: string}>,
    ) => Promise<void>,
) {
    const root = await mkdtemp(join(tmpdir(), 'agent-storm-finish-'));
    const originPath = join(root, 'origin.git');
    const parent = join(root, 'repo');
    const mainPath = join(parent, 'main');
    const featurePath = join(parent, 'feature');
    try {
        await git(root, [
            'init',
            '--bare',
            '--initial-branch=main',
            originPath,
        ]);
        await git(root, [
            'clone',
            '--quiet',
            originPath,
            mainPath,
        ]);
        await git(mainPath, [
            'config',
            'user.email',
            'test@example.com',
        ]);
        await git(mainPath, [
            'config',
            'user.name',
            'Test User',
        ]);
        await git(mainPath, [
            'checkout',
            '--quiet',
            '-B',
            'main',
        ]);
        await writeFile(join(mainPath, 'tracked.txt'), 'base\n');
        await git(mainPath, [
            'add',
            'tracked.txt',
        ]);
        await git(mainPath, [
            'commit',
            '--quiet',
            '-m',
            'Initial commit',
        ]);
        await git(mainPath, [
            'push',
            '--quiet',
            '-u',
            'origin',
            'main',
        ]);
        await git(mainPath, [
            'remote',
            'set-head',
            'origin',
            'main',
        ]);
        await git(mainPath, [
            'worktree',
            'add',
            '--quiet',
            '-b',
            'feature',
            featurePath,
        ]);
        await run({
            parent: normalizePath(parent),
            mainPath: normalizePath(mainPath),
            featurePath: normalizePath(featurePath),
        });
    } finally {
        await rm(root, {
            recursive: true,
            force: true,
        });
    }
}

async function commitFile({folder, fileName}: Readonly<{folder: string; fileName: string}>) {
    await writeFile(join(folder, fileName), `${fileName}\n`);
    await git(folder, [
        'add',
        fileName,
    ]);
    await git(folder, [
        'commit',
        '--quiet',
        '-m',
        `Add ${fileName}`,
    ]);
}

describe(decideBranchDeletion.name, () => {
    it('deletes a branch merged into the default branch', () => {
        assert.isTrue(
            decideBranchDeletion({
                gitState: gitState({
                    isMergedIntoDefault: true,
                }),
                pr: undefined,
            }).willDelete,
        );
    });

    it("deletes a squash-merged branch whose tip is the merged PR's head", () => {
        assert.isTrue(
            decideBranchDeletion({
                gitState: gitState({}),
                pr: branchPr({
                    state: 'MERGED',
                }),
            }).willDelete,
        );
    });

    it('keeps a branch that moved after its PR merged', () => {
        assert.isFalse(
            decideBranchDeletion({
                gitState: gitState({}),
                pr: branchPr({
                    state: 'MERGED',
                    headRefOid: 'b'.repeat(40),
                }),
            }).willDelete,
        );
    });

    it('keeps an unmerged branch with an open PR', () => {
        assert.isFalse(
            decideBranchDeletion({
                gitState: gitState({}),
                pr: branchPr({}),
            }).willDelete,
        );
    });

    it('keeps the default branch, even when it counts as merged', () => {
        assert.isFalse(
            decideBranchDeletion({
                gitState: gitState({
                    branch: 'main',
                    isMergedIntoDefault: true,
                }),
                pr: undefined,
            }).willDelete,
        );
    });

    it('keeps a branch checked out in another worktree', () => {
        assert.isFalse(
            decideBranchDeletion({
                gitState: gitState({
                    isMergedIntoDefault: true,
                    otherCheckoutPath: '/elsewhere',
                }),
                pr: undefined,
            }).willDelete,
        );
    });

    it('keeps the branch when the default branch is unknown', () => {
        assert.isFalse(
            decideBranchDeletion({
                gitState: gitState({
                    defaultBranch: undefined,
                }),
                pr: branchPr({
                    state: 'MERGED',
                }),
            }).willDelete,
        );
    });

    it('has nothing to delete on a detached HEAD', () => {
        assert.isFalse(
            decideBranchDeletion({
                gitState: gitState({
                    branch: undefined,
                    isMergedIntoDefault: true,
                }),
                pr: undefined,
            }).willDelete,
        );
    });
});

describe(findLostWork.name, () => {
    it('reports uncommitted files and unpushed commits', () => {
        assert.isLengthExactly(
            findLostWork({
                gitState: gitState({
                    uncommittedFiles: [
                        '?? new.txt',
                    ],
                    unpushedCommits: [
                        'abc1234 Add new.txt',
                    ],
                }),
                pr: branchPr({}),
            }),
            2,
        );
    });

    it("forgives unpushed commits once a merged PR's head is the tip", () => {
        assert.isEmpty(
            findLostWork({
                gitState: gitState({
                    unpushedCommits: [
                        'abc1234 Add new.txt',
                    ],
                }),
                pr: branchPr({
                    state: 'MERGED',
                }),
            }),
        );
    });

    it('still reports uncommitted files after a merged PR', () => {
        assert.isLengthExactly(
            findLostWork({
                gitState: gitState({
                    uncommittedFiles: [
                        ' M tracked.txt',
                    ],
                }),
                pr: branchPr({
                    state: 'MERGED',
                }),
            }),
            1,
        );
    });
});

describe(pickBranchPr.name, () => {
    it('prefers the merged PR at the tip, then an open one, then the first', () => {
        const closed = branchPr({
            number: 1,
            state: 'CLOSED',
        });
        const open = branchPr({
            number: 2,
        });
        const mergedEarlier = branchPr({
            number: 3,
            state: 'MERGED',
            headRefOid: 'b'.repeat(40),
        });
        const mergedAtTip = branchPr({
            number: 4,
            state: 'MERGED',
        });
        assert.deepEquals(
            [
                pickBranchPr({
                    prs: [
                        closed,
                        open,
                        mergedEarlier,
                        mergedAtTip,
                    ],
                    tipOid,
                })?.number,
                pickBranchPr({
                    prs: [
                        closed,
                        mergedEarlier,
                        open,
                    ],
                    tipOid,
                })?.number,
                pickBranchPr({
                    prs: [
                        closed,
                        mergedEarlier,
                    ],
                    tipOid,
                })?.number,
                pickBranchPr({
                    prs: [],
                    tipOid,
                })?.number,
            ],
            [
                4,
                2,
                1,
                undefined,
            ],
        );
    });
});

describe(findFolderRefusal.name, () => {
    const listed = {
        isWorktreeRoot: false,
    };

    it('accepts a linked worktree inside a listed repo', async () => {
        await withRepo(async ({parent, featurePath}) => {
            assert.isUndefined(
                await findFolderRefusal({
                    folder: featurePath,
                    info: {
                        ...listed,
                        parentRepoPath: parent,
                    },
                }),
            );
        });
    });

    it('refuses a folder agent-storm does not list', async () => {
        await withRepo(async ({featurePath}) => {
            assert.isString(
                await findFolderRefusal({
                    folder: featurePath,
                    info: undefined,
                }),
            );
        });
    });

    it('refuses a repo root', async () => {
        await withRepo(async ({parent}) => {
            assert.isString(
                await findFolderRefusal({
                    folder: parent,
                    info: {
                        isWorktreeRoot: true,
                        parentRepoPath: null,
                    },
                }),
            );
        });
    });

    it('refuses a folder that is not directly inside its repo', async () => {
        await withRepo(async ({featurePath}) => {
            assert.isString(
                await findFolderRefusal({
                    folder: featurePath,
                    info: {
                        ...listed,
                        parentRepoPath: '/somewhere/else',
                    },
                }),
            );
        });
    });

    it('refuses the main checkout', async () => {
        await withRepo(async ({parent, mainPath}) => {
            assert.isString(
                await findFolderRefusal({
                    folder: mainPath,
                    info: {
                        ...listed,
                        parentRepoPath: parent,
                    },
                }),
            );
        });
    });

    it("refuses the repo's last worktree", async () => {
        await withRepo(async ({parent, mainPath, featurePath}) => {
            await rm(join(mainPath, '.git'), {
                recursive: true,
                force: true,
            });
            assert.isString(
                await findFolderRefusal({
                    folder: featurePath,
                    info: {
                        ...listed,
                        parentRepoPath: parent,
                    },
                }),
            );
        });
    });
});

describe(readWorktreeGitState.name, () => {
    it('sees a fresh worktree as merged with nothing to lose', async () => {
        await withRepo(async ({featurePath}) => {
            const state = await readWorktreeGitState(featurePath);
            assert.deepEquals(
                {
                    ...state,
                    tipOid: !!state.tipOid,
                },
                {
                    branch: 'feature',
                    tipOid: true,
                    defaultBranch: 'main',
                    isMergedIntoDefault: true,
                    uncommittedFiles: [],
                    unpushedCommits: [],
                    otherCheckoutPath: undefined,
                },
            );
        });
    });

    it('sees new commits and untracked files', async () => {
        await withRepo(async ({featurePath}) => {
            await commitFile({
                folder: featurePath,
                fileName: 'committed.txt',
            });
            await writeFile(join(featurePath, 'untracked.txt'), 'untracked\n');
            const state = await readWorktreeGitState(featurePath);
            assert.deepEquals(
                {
                    isMergedIntoDefault: state.isMergedIntoDefault,
                    uncommittedFiles: state.uncommittedFiles,
                    unpushedCount: state.unpushedCommits.length,
                },
                {
                    isMergedIntoDefault: false,
                    uncommittedFiles: [
                        '?? untracked.txt',
                    ],
                    unpushedCount: 1,
                },
            );
        });
    });

    it('treats pushed commits as safe', async () => {
        await withRepo(async ({featurePath}) => {
            await commitFile({
                folder: featurePath,
                fileName: 'committed.txt',
            });
            await git(featurePath, [
                'push',
                '--quiet',
                '-u',
                'origin',
                'feature',
            ]);
            assert.isEmpty((await readWorktreeGitState(featurePath)).unpushedCommits);
        });
    });

    it('sees the branch checked out in another worktree', async () => {
        await withRepo(async ({parent, mainPath, featurePath}) => {
            const copyPath = join(parent, 'feature-copy');
            await git(mainPath, [
                'worktree',
                'add',
                '--quiet',
                '--force',
                copyPath,
                'feature',
            ]);
            assert.strictEquals(
                (await readWorktreeGitState(featurePath)).otherCheckoutPath,
                normalizePath(copyPath),
            );
        });
    });
});

describe(deleteBranchIfUnchanged.name, () => {
    it('deletes a branch that still points at the checked tip', async () => {
        await withRepo(async ({mainPath, featurePath}) => {
            await commitFile({
                folder: featurePath,
                fileName: 'committed.txt',
            });
            const featureTip = await git(featurePath, [
                'rev-parse',
                'HEAD',
            ]);
            await git(mainPath, [
                'worktree',
                'remove',
                featurePath,
            ]);
            await deleteBranchIfUnchanged({
                cwd: mainPath,
                branch: 'feature',
                tipOid: featureTip,
            });
            assert.strictEquals(
                await git(mainPath, [
                    'branch',
                    '--list',
                    'feature',
                ]),
                '',
            );
        });
    });

    it('keeps a branch that moved since the check', async () => {
        await withRepo(async ({mainPath, featurePath}) => {
            const checkedTip = await git(featurePath, [
                'rev-parse',
                'HEAD',
            ]);
            await commitFile({
                folder: featurePath,
                fileName: 'committed.txt',
            });
            await git(mainPath, [
                'worktree',
                'remove',
                featurePath,
            ]);
            await deleteBranchIfUnchanged({
                cwd: mainPath,
                branch: 'feature',
                tipOid: checkedTip,
            });
            assert.strictEquals(
                await git(mainPath, [
                    'branch',
                    '--list',
                    'feature',
                ]),
                'feature',
            );
        });
    });

    it('keeps a branch some worktree still has checked out', async () => {
        await withRepo(async ({mainPath, featurePath}) => {
            await deleteBranchIfUnchanged({
                cwd: mainPath,
                branch: 'feature',
                tipOid: await git(featurePath, [
                    'rev-parse',
                    'HEAD',
                ]),
            });
            assert.strictEquals(
                await git(mainPath, [
                    'branch',
                    '--list',
                    'feature',
                ]),
                '+ feature',
            );
        });
    });
});
