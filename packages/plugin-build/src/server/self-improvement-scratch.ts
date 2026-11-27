// cspell:word gpgsign
import {readFileIfExists} from '@augment-vir/node';
import {runCommand} from 'agent-storm-util';
import {type AnyDuration} from 'date-vir';
import {constants} from 'node:fs';
import {cp, mkdir, readdir, rm, stat, writeFile} from 'node:fs/promises';
import {basename, join, relative, sep} from 'node:path';

/** Copying the checkout includes its `node_modules`, and adding it all to git takes a while. */
const scratchGitTimeout = {
    minutes: 5,
} as const satisfies AnyDuration;

/**
 * Top-level folders of the checkout a scratch copy leaves out: git history, logs, the user's own
 * scratch files, and release builds. `node_modules` and `dist` stay, since the workspace's packages
 * link to each other through them.
 */
const skippedTopLevelNames = [
    '.git',
    '.history',
    '.logs',
    '.not-committed',
    'coverage',
];

/** Kept out of git, so the journal and digest never end up in a proposal. */
export function findScratchNotesDir(scratchPath: string) {
    return join(scratchPath, '.not-committed');
}

async function runScratchGit(scratchPath: string, args: ReadonlyArray<string>) {
    return await runCommand(
        'git',
        [
            '-c',
            'user.name=Agent Storm',
            '-c',
            'user.email=agent-storm@localhost',
            '-c',
            'commit.gpgsign=false',
            ...args,
        ],
        {
            cwd: scratchPath,
            timeout: scratchGitTimeout,
        },
    );
}

/**
 * Writes everything that changed in the scratch copy since `baselineCommit` to `patchPath` as a
 * binary-safe patch the live checkout can `git apply`. Returns whether there was anything.
 */
export async function writeScratchPatch({
    scratchPath,
    baselineCommit,
    patchPath,
}: Readonly<{scratchPath: string; baselineCommit: string; patchPath: string}>) {
    await runScratchGit(scratchPath, [
        'add',
        '--all',
    ]);
    await runScratchGit(scratchPath, [
        'diff',
        '--cached',
        '--binary',
        baselineCommit,
        `--output=${patchPath}`,
    ]);
    return ((await stat(patchPath).catch(() => undefined))?.size ?? 0) > 0;
}

/**
 * Replaces the scratch copy's contents with a fresh copy of `checkoutPath` and commits it to a new
 * git repo, returning that commit. Empties the folder instead of deleting it, since a thread's AI
 * process keeps it as its working directory.
 */
export async function resetScratchCopy({
    checkoutPath,
    scratchPath,
}: Readonly<{checkoutPath: string; scratchPath: string}>) {
    await mkdir(scratchPath, {
        recursive: true,
    });
    await Promise.all(
        (await readdir(scratchPath)).map(async (name) => {
            await rm(join(scratchPath, name), {
                recursive: true,
                force: true,
            });
        }),
    );
    await cp(checkoutPath, scratchPath, {
        recursive: true,
        mode: constants.COPYFILE_FICLONE,
        verbatimSymlinks: true,
        filter(source) {
            const topLevelName = relative(checkoutPath, source).split(sep)[0] || '';
            return (
                !skippedTopLevelNames.includes(topLevelName) &&
                !topLevelName.startsWith('dist-release') &&
                basename(source) !== '.DS_Store'
            );
        },
    });
    await mkdir(findScratchNotesDir(scratchPath), {
        recursive: true,
    });
    await runScratchGit(scratchPath, [
        'init',
        '--quiet',
    ]);
    await runScratchGit(scratchPath, [
        'add',
        '--all',
    ]);
    await runScratchGit(scratchPath, [
        'commit',
        '--quiet',
        '--no-verify',
        '--message',
        'Live checkout',
    ]);
    return (
        await runScratchGit(scratchPath, [
            'rev-parse',
            'HEAD',
        ])
    ).stdout.trim();
}

/**
 * Applies a previous run's unapproved changes to a fresh scratch copy. Changes the live checkout
 * already has are skipped. A patch that no longer applies is kept at `unappliedPatchPath`, and the
 * returned message says so.
 */
export async function carryPatchForward({
    scratchPath,
    patchPath,
    unappliedPatchPath,
}: Readonly<{scratchPath: string; patchPath: string; unappliedPatchPath: string}>) {
    const patch = await readFileIfExists(patchPath);
    if (!patch) {
        return undefined;
    }
    const isAlreadyLive = await runScratchGit(scratchPath, [
        'apply',
        '--reverse',
        '--check',
        patchPath,
    ]).then(
        () => true,
        () => false,
    );
    if (isAlreadyLive) {
        return 'The user already copied your previous changes into the live checkout.';
    }
    try {
        await runScratchGit(scratchPath, [
            'apply',
            patchPath,
        ]);
        return 'Your previous changes the user has not copied over yet are applied to this copy again.';
    } catch {
        await writeFile(unappliedPatchPath, patch);
        return `Your previous changes no longer apply to the live checkout, so they were left out. They are in ${unappliedPatchPath}; redo whatever is still worth it.`;
    }
}
