// cspell:words numstat, unstaging, nowarn, unidiff

import {
    GitDiffSide,
    GitFileChange,
    maxDiffFileBytes,
    maxDiffFileLines,
    type GitDiffFile,
    type GitDiffStatus,
} from '@agent-storm/common';
import {arrayToObject, awaitedForEach, removeDuplicates} from '@augment-vir/common';
import {execFile} from 'node:child_process';
import {readFile, rm} from 'node:fs/promises';
import {isAbsolute, relative, resolve} from 'node:path';
import {promisify} from 'node:util';

const exec = promisify(execFile);

/**
 * Buffer ceiling for these git calls. `git show` of a single blob is bounded by
 * {@link maxDiffFileBytes}; the status and numstat calls are bounded by how many files changed,
 * which for a pathological repo is still large. Node's 1 MB default throws `ENOBUFS`, which would
 * silently blank the pane, so both get a generous cap.
 */
const gitMaxBuffer = maxDiffFileBytes * 4;

/**
 * How many leading bytes get scanned for a NUL when deciding whether a file is binary. Same
 * heuristic git uses — a text file has no NUL in its first block.
 */
const binarySniffBytes = 8000;

const newlineByte = 0x0a;

/** Unified-diff context lines emitted on each side of a staged or unstaged hunk. */
const hunkContextLines = 3;

/** Fallback file mode for the `new file` / `deleted file` patch headers. */
const defaultFileMode = '100644';

async function runGitText(
    folder: string,
    args: ReadonlyArray<string>,
): Promise<string | undefined> {
    const result = await exec('git', [...args], {
        cwd: folder,
        maxBuffer: gitMaxBuffer,
    }).catch(() => undefined);
    return result?.stdout;
}

/**
 * Run a git command that is expected to succeed, surfacing git's own stderr on failure. Used for
 * the index-mutating calls, where a silent no-op would leave the user staring at an unchanged pane
 * with no explanation.
 */
async function runGitOrThrow(
    folder: string,
    args: ReadonlyArray<string>,
    stdin?: string | undefined,
): Promise<void> {
    const child = exec('git', [...args], {
        cwd: folder,
        maxBuffer: gitMaxBuffer,
    });
    if (stdin != undefined) {
        child.child.stdin?.end(stdin);
    }
    await child.catch((error: unknown) => {
        const stderr =
            error && typeof error === 'object' && 'stderr' in error ? String(error.stderr) : '';
        throw new Error(`git ${args[0]} failed: ${stderr.trim() || String(error)}`);
    });
}

/**
 * Map one column of `git status --porcelain`'s two-letter code to a change kind. Each column
 * describes a single tree comparison, so unlike the two-letter code there is nothing to collapse.
 */
function changeFromStatusLetter(letter: string): GitFileChange {
    const byLetter: Readonly<Record<string, GitFileChange>> = {
        A: GitFileChange.Added,
        C: GitFileChange.Added,
        D: GitFileChange.Deleted,
        M: GitFileChange.Modified,
        R: GitFileChange.Renamed,
        '?': GitFileChange.Untracked,
    };
    return byLetter[letter] ?? GitFileChange.Modified;
}

type StatusEntry = {
    path: string;
    oldPath: string | undefined;
    /** Index column: what a commit right now would record. Undefined when the index matches HEAD. */
    stagedChange: GitFileChange | undefined;
    /** Worktree column: what a commit right now would leave behind. */
    unstagedChange: GitFileChange | undefined;
};

/**
 * Parse `git status --porcelain=v1 -z`. Records are NUL-terminated `XY <path>`; a rename or copy
 * record is followed by one extra NUL-terminated field holding the original path. That trailing
 * field is the reason for the `skipNext` carry — the parser has to consume a second record for
 * those entries rather than treat it as its own file.
 */
function parseStatus(raw: string): StatusEntry[] {
    const records = raw.split('\0').filter((record) => record);
    return records.reduce<{
        entries: StatusEntry[];
        skipNext: boolean;
    }>(
        (accumulated, record, index) => {
            if (accumulated.skipNext) {
                return {
                    entries: accumulated.entries,
                    skipNext: false,
                };
            }
            const indexLetter = record.slice(0, 1);
            const worktreeLetter = record.slice(1, 2);
            const isRenameOrCopy = indexLetter === 'R' || indexLetter === 'C';
            return {
                entries: [
                    ...accumulated.entries,
                    {
                        path: record.slice(3),
                        oldPath: isRenameOrCopy ? records[index + 1] : undefined,
                        /**
                         * `?` in the index column means untracked, which is an unstaged-only state
                         * — there is nothing in the index to compare against yet.
                         */
                        stagedChange:
                            indexLetter === ' ' || indexLetter === '?'
                                ? undefined
                                : changeFromStatusLetter(indexLetter),
                        unstagedChange:
                            worktreeLetter === ' '
                                ? undefined
                                : changeFromStatusLetter(worktreeLetter),
                    },
                ],
                skipNext: isRenameOrCopy,
            };
        },
        {
            entries: [],
            skipNext: false,
        },
    ).entries;
}

/**
 * Parse `git diff --numstat -z --no-renames`, whose every record is `<insertions>\t<deletions>\t
 * <path>`. `--no-renames` is what keeps that uniform: with rename detection on, a renamed file
 * splits its path across two extra NUL-separated fields and the parse needs lookahead. Binary files
 * report `-` for both counts, which becomes `0`.
 */
function parseNumstat(
    raw: string,
): Partial<Record<string, {insertions: number; deletions: number}>> {
    return arrayToObject(
        raw.split('\0').filter((record) => record),
        (record) => {
            const [
                insertionsRaw,
                deletionsRaw,
                path,
            ] = record.split('\t');
            if (!path) {
                return undefined;
            }
            return {
                key: path,
                value: {
                    insertions: Number(insertionsRaw) || 0,
                    deletions: Number(deletionsRaw) || 0,
                },
            };
        },
    );
}

export async function getDiffStatus(folder: string): Promise<GitDiffStatus> {
    const [
        statusRaw,
        stagedNumstatRaw,
        unstagedNumstatRaw,
    ] = await Promise.all([
        runGitText(folder, [
            'status',
            '--porcelain=v1',
            '-z',
            '--untracked-files=all',
        ]),
        /**
         * Fails on a repo with no commits yet — there is no `HEAD` to diff against. The status call
         * still works there, so an undefined numstat just means every file shows `0/0`.
         */
        runGitText(folder, [
            'diff',
            '--numstat',
            '-z',
            '--no-renames',
            '--cached',
            'HEAD',
            '--',
        ]),
        runGitText(folder, [
            'diff',
            '--numstat',
            '-z',
            '--no-renames',
            '--',
        ]),
    ]);

    if (statusRaw == undefined) {
        return {
            staged: [],
            unstaged: [],
        };
    }

    const stagedCounts = parseNumstat(stagedNumstatRaw || '');
    const unstagedCounts = parseNumstat(unstagedNumstatRaw || '');
    const entries = parseStatus(statusRaw);

    function toFile(
        entry: Readonly<StatusEntry>,
        change: GitFileChange,
        counts: Partial<Record<string, {insertions: number; deletions: number}>>,
    ): GitDiffFile {
        return {
            path: entry.path,
            change,
            oldPath: entry.oldPath,
            insertions: counts[entry.path]?.insertions ?? 0,
            deletions: counts[entry.path]?.deletions ?? 0,
        };
    }

    return {
        staged: entries
            .filter((entry) => entry.stagedChange)
            .map((entry) =>
                toFile(entry, entry.stagedChange ?? GitFileChange.Modified, stagedCounts),
            ),
        unstaged: entries
            .filter((entry) => entry.unstagedChange)
            .map((entry) =>
                toFile(entry, entry.unstagedChange ?? GitFileChange.Modified, unstagedCounts),
            ),
    };
}

/**
 * Guard against a client asking for a path outside the repo (`../../.ssh/id_rsa`). Git only ever
 * hands out repo-relative paths, so anything absolute or escaping upward is rejected outright.
 */
function resolveRepoPath({
    folder,
    repoRelativePath,
}: Readonly<{folder: string; repoRelativePath: string}>): string | undefined {
    if (!repoRelativePath || isAbsolute(repoRelativePath)) {
        return undefined;
    }
    const resolved = resolve(folder, repoRelativePath);
    const relativeToFolder = relative(folder, resolved);
    if (!relativeToFolder || relativeToFolder.startsWith('..') || isAbsolute(relativeToFolder)) {
        return undefined;
    }
    return resolved;
}

function looksBinary(contents: Readonly<Buffer>): boolean {
    return contents.subarray(0, binarySniffBytes).includes(0);
}

/** Read a blob by git revision spec (`HEAD:path`, `:path`). Empty when the blob doesn't exist. */
async function readBlob({folder, spec}: Readonly<{folder: string; spec: string}>): Promise<Buffer> {
    const result = await exec(
        'git',
        [
            'show',
            spec,
        ],
        {
            cwd: folder,
            maxBuffer: gitMaxBuffer,
            encoding: 'buffer',
        },
    ).catch(() => undefined);
    return result?.stdout ?? Buffer.alloc(0);
}

/** Whether a blob exists at the given revision spec, distinguishing "empty" from "absent". */
async function blobExists({
    folder,
    spec,
}: Readonly<{folder: string; spec: string}>): Promise<boolean> {
    return await exec(
        'git',
        [
            'cat-file',
            '-e',
            spec,
        ],
        {
            cwd: folder,
        },
    )
        .then(() => true)
        .catch(() => false);
}

type SidePaths = {
    /** Revision spec for the diff's old side, or undefined when that side is the working tree. */
    oldSpec: string;
    /** Revision spec for the new side; undefined means read the working-tree file. */
    newSpec: string | undefined;
};

/**
 * The two things a diff of `side` compares. Staged is `HEAD` → index, unstaged is index → working
 * tree. A rename only needs its pre-rename path on the staged side, because the index already holds
 * the file under its new name by the time the worktree diff is taken.
 */
function specsForSide({
    path,
    oldPath,
    side,
}: Readonly<{path: string; oldPath: string | undefined; side: GitDiffSide}>): SidePaths {
    const bySide: Readonly<Record<GitDiffSide, SidePaths>> = {
        [GitDiffSide.Staged]: {
            oldSpec: `HEAD:${oldPath || path}`,
            newSpec: `:${path}`,
        },
        [GitDiffSide.Unstaged]: {
            oldSpec: `:${path}`,
            newSpec: undefined,
        },
    };
    return bySide[side];
}

async function readSideBuffers({
    folder,
    path,
    oldPath,
    side,
}: Readonly<{
    folder: string;
    path: string;
    oldPath: string | undefined;
    side: GitDiffSide;
}>): Promise<{oldBuffer: Buffer; newBuffer: Buffer}> {
    const workingPath = resolveRepoPath({
        folder,
        repoRelativePath: path,
    });
    if (
        !workingPath ||
        !resolveRepoPath({
            folder,
            repoRelativePath: oldPath || path,
        })
    ) {
        throw new Error('Refusing to read a path outside the repo.');
    }

    const specs = specsForSide({
        path,
        oldPath,
        side,
    });
    const [
        oldBuffer,
        newBuffer,
    ] = await Promise.all([
        readBlob({
            folder,
            spec: specs.oldSpec,
        }),
        specs.newSpec == undefined
            ? /** Missing means the file was deleted from the working tree — an empty new side. */
              readFile(workingPath).catch(() => Buffer.alloc(0))
            : readBlob({
                  folder,
                  spec: specs.newSpec,
              }),
    ]);
    return {
        oldBuffer,
        newBuffer,
    };
}

/** Counted on the buffer rather than a decoded string so a multi-megabyte blob isn't decoded twice. */
function countLines(buffer: Readonly<Buffer>): number {
    return buffer.reduce((count, byte) => (byte === newlineByte ? count + 1 : count), 1);
}

export async function getDiffFileContents(
    params: Readonly<{
        folder: string;
        path: string;
        oldPath: string | undefined;
        side: GitDiffSide;
        allowLarge: boolean;
    }>,
) {
    const {oldBuffer, newBuffer} = await readSideBuffers(params);

    const binary = looksBinary(oldBuffer) || looksBinary(newBuffer);
    const tooLarge =
        oldBuffer.byteLength > maxDiffFileBytes ||
        newBuffer.byteLength > maxDiffFileBytes ||
        countLines(oldBuffer) > maxDiffFileLines ||
        countLines(newBuffer) > maxDiffFileLines;
    const withheld = binary || (tooLarge && !params.allowLarge);

    return {
        oldContent: withheld ? '' : oldBuffer.toString('utf8'),
        newContent: withheld ? '' : newBuffer.toString('utf8'),
        tooLargeOrBinary: withheld,
        canShowAnyway: withheld && !binary,
    };
}

export async function setFileStaged({
    folder,
    path,
    side,
}: Readonly<{folder: string; path: string; side: GitDiffSide}>): Promise<void> {
    if (
        !resolveRepoPath({
            folder,
            repoRelativePath: path,
        })
    ) {
        throw new Error('Refusing to stage a path outside the repo.');
    } else if (side === GitDiffSide.Unstaged) {
        /** `-A` is what makes this also stage a deletion rather than only content changes. */
        await runGitOrThrow(folder, [
            'add',
            '-A',
            '--',
            path,
        ]);
        return;
    }
    /**
     * `restore --staged` needs a HEAD to restore the index entry from. In a repo with no commits
     * yet there is none, and dropping the index entry entirely is the equivalent operation.
     */
    await runGitOrThrow(folder, [
        'restore',
        '--staged',
        '--',
        path,
    ]).catch(async () => {
        await runGitOrThrow(folder, [
            'rm',
            '--cached',
            '--force',
            '--',
            path,
        ]);
    });
}

/**
 * Throw away one file's changes on both sides of the index at once. Three cases, decided by where
 * the file exists:
 *
 * - In `HEAD`: one `restore` puts both the index entry and the working tree copy back.
 * - Only in the index (a staged new file): drop the index entry, then delete the file — there is no
 *   `HEAD` state to restore it to.
 * - Neither (untracked): delete the file.
 */
export async function discardFileChanges({
    folder,
    path,
}: Readonly<{folder: string; path: string}>): Promise<void> {
    const absolutePath = resolveRepoPath({
        folder,
        repoRelativePath: path,
    });
    if (!absolutePath) {
        throw new Error('Refusing to discard a path outside the repo.');
    } else if (
        await blobExists({
            folder,
            spec: `HEAD:${path}`,
        })
    ) {
        await runGitOrThrow(folder, [
            'restore',
            '--staged',
            '--worktree',
            '--source=HEAD',
            '--',
            path,
        ]);
        return;
    }
    if (
        await blobExists({
            folder,
            spec: `:${path}`,
        })
    ) {
        await runGitOrThrow(folder, [
            'rm',
            '--cached',
            '--force',
            '--',
            path,
        ]);
    }
    await rm(absolutePath, {
        force: true,
        recursive: true,
    });
}

/**
 * {@link setFileStaged} for every file currently on one side. Sequential because each git call takes
 * `index.lock` and parallel ones would fail on the contention.
 */
export async function setSideStaged({
    folder,
    side,
}: Readonly<{folder: string; side: GitDiffSide}>): Promise<void> {
    const status = await getDiffStatus(folder);
    const files = side === GitDiffSide.Staged ? status.staged : status.unstaged;
    await awaitedForEach(files, async (file) => {
        await setFileStaged({
            folder,
            path: file.path,
            side,
        });
    });
}

/**
 * {@link discardFileChanges} for every changed file. Paths are collected from both sides and
 * deduped: a partially-staged file is reported on each, and the second discard would throw on the
 * file the first one already deleted.
 */
export async function discardAllChanges(folder: string): Promise<void> {
    const status = await getDiffStatus(folder);
    const paths = removeDuplicates([
        ...status.staged.map((file) => file.path),
        ...status.unstaged.map((file) => file.path),
    ]);
    await awaitedForEach(paths, async (path) => {
        await discardFileChanges({
            folder,
            path,
        });
    });
}

/**
 * Split text into lines without the synthetic empty entry a trailing newline produces, and report
 * whether that newline was there. Unified diffs need both: the line list to emit, and the `\ No
 * newline at end of file` marker when it's missing.
 */
function toLines(content: string): {lines: string[]; endsWithNewline: boolean} {
    if (!content) {
        return {
            lines: [],
            endsWithNewline: true,
        };
    }
    const endsWithNewline = content.endsWith('\n');
    const lines = content.split('\n');
    return {
        lines: endsWithNewline ? lines.slice(0, -1) : lines,
        endsWithNewline,
    };
}

const noNewlineMarker = String.raw`\ No newline at end of file`;

/**
 * Build a one-hunk unified diff for the given line ranges. The ranges address the same two
 * documents the client is displaying, so the patch describes exactly the change the user clicked on
 * — no more, no less. Feeding it to `git apply --cached` moves only that change across the index.
 */
function buildHunkPatch({
    path,
    oldContent,
    newContent,
    fromOldLine,
    toOldLine,
    fromNewLine,
    toNewLine,
    mode,
    oldSideExists,
    newSideExists,
    contextLines,
}: Readonly<{
    path: string;
    oldContent: string;
    newContent: string;
    fromOldLine: number;
    toOldLine: number;
    fromNewLine: number;
    toNewLine: number;
    mode: string;
    oldSideExists: boolean;
    newSideExists: boolean;
    contextLines: number;
}>): string {
    const old = toLines(oldContent);
    const fresh = toLines(newContent);

    const contextStartOld = Math.max(0, fromOldLine - contextLines);
    const contextEndOld = Math.min(old.lines.length, toOldLine + contextLines);
    /** Context lines are shared, so the new side's window shifts by the same amounts. */
    const contextStartNew = fromNewLine - (fromOldLine - contextStartOld);
    const contextEndNew = toNewLine + (contextEndOld - toOldLine);

    const oldCount = contextEndOld - contextStartOld;
    const newCount = contextEndNew - contextStartNew;

    const leadingContext = old.lines.slice(contextStartOld, fromOldLine);
    const removed = old.lines.slice(fromOldLine, toOldLine);
    const added = fresh.lines.slice(fromNewLine, toNewLine);
    const trailingContext = old.lines.slice(toOldLine, contextEndOld);

    /**
     * A missing trailing newline has to be marked against whichever side's final line lands in the
     * hunk. When the last emitted line is shared context both sides agree by definition — a line
     * that differs only in its trailing newline can't be context.
     */
    const oldEndsInHunk = contextEndOld === old.lines.length && !old.endsWithNewline;
    const newEndsInHunk = contextEndNew === fresh.lines.length && !fresh.endsWithNewline;
    const markAfterTrailingContext = trailingContext.length > 0 && oldEndsInHunk;

    const body = [
        ...leadingContext.map((line) => ` ${line}`),
        ...removed.map((line) => `-${line}`),
        ...(removed.length > 0 && trailingContext.length === 0 && oldEndsInHunk
            ? [noNewlineMarker]
            : []),
        ...added.map((line) => `+${line}`),
        ...(added.length > 0 && trailingContext.length === 0 && newEndsInHunk
            ? [noNewlineMarker]
            : []),
        ...trailingContext.map((line) => ` ${line}`),
        ...(markAfterTrailingContext ? [noNewlineMarker] : []),
    ];

    /** Unified diffs address an empty range by its preceding line, so a 0-count start isn't +1'd. */
    const oldStart = oldCount === 0 ? contextStartOld : contextStartOld + 1;
    const newStart = newCount === 0 ? contextStartNew : contextStartNew + 1;

    const oldHeaderPath = oldSideExists ? `a/${path}` : '/dev/null';
    const newHeaderPath = newSideExists ? `b/${path}` : '/dev/null';

    return [
        `diff --git a/${path} b/${path}`,
        ...(oldSideExists ? [] : [`new file mode ${mode}`]),
        ...(newSideExists ? [] : [`deleted file mode ${mode}`]),
        `--- ${oldHeaderPath}`,
        `+++ ${newHeaderPath}`,
        `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
        ...body,
        '',
    ].join('\n');
}

/** File mode recorded in the index, falling back to a plain non-executable file. */
async function indexFileMode({
    folder,
    path,
}: Readonly<{folder: string; path: string}>): Promise<string> {
    const raw = await runGitText(folder, [
        'ls-files',
        '--stage',
        '--',
        path,
    ]);
    return raw?.trim().split(' ')[0] || defaultFileMode;
}

/**
 * Reverse-apply one hunk so the change it describes is gone rather than moved. Which trees that
 * touches depends on where the hunk lives: an unstaged hunk only exists in the working tree, so
 * reverting it there is enough. A staged one is already in the index, and reverting it only there
 * would leave the same edit sitting unstaged in the working tree — `--index` takes it out of both.
 *
 * `--index` requires the working tree to match the index for those lines, so a file that is
 * partially staged and then edited again fails the apply instead of silently discarding the wrong
 * version.
 */
const discardApplyArgsBySide: Readonly<Record<GitDiffSide, ReadonlyArray<string>>> = {
    [GitDiffSide.Unstaged]: [],
    [GitDiffSide.Staged]: ['--index'],
};

type HunkRequest = Readonly<{
    folder: string;
    path: string;
    oldPath: string | undefined;
    side: GitDiffSide;
    fromOldLine: number;
    toOldLine: number;
    fromNewLine: number;
    toNewLine: number;
}>;

/** The two sides' current contents turned into a one-hunk patch describing just the given range. */
async function buildSideHunkPatch({
    folder,
    path,
    oldPath,
    side,
    fromOldLine,
    toOldLine,
    fromNewLine,
    toNewLine,
    contextLines,
}: HunkRequest & Readonly<{contextLines: number}>): Promise<string> {
    const {oldBuffer, newBuffer} = await readSideBuffers({
        folder,
        path,
        oldPath,
        side,
    });
    if (looksBinary(oldBuffer) || looksBinary(newBuffer)) {
        throw new Error('Cannot change part of a binary file.');
    }

    const specs = specsForSide({
        path,
        oldPath,
        side,
    });
    const [
        oldSideExists,
        newSideExists,
        mode,
    ] = await Promise.all([
        blobExists({
            folder,
            spec: specs.oldSpec,
        }),
        specs.newSpec == undefined
            ? Promise.resolve(newBuffer.byteLength > 0)
            : blobExists({
                  folder,
                  spec: specs.newSpec,
              }),
        indexFileMode({
            folder,
            path,
        }),
    ]);

    return buildHunkPatch({
        path,
        oldContent: oldBuffer.toString('utf8'),
        newContent: newBuffer.toString('utf8'),
        fromOldLine,
        toOldLine,
        fromNewLine,
        toNewLine,
        mode,
        oldSideExists,
        newSideExists,
        contextLines,
    });
}

export async function moveHunkAcrossIndex(request: HunkRequest): Promise<void> {
    const patch = await buildSideHunkPatch({
        ...request,
        contextLines: hunkContextLines,
    });
    /**
     * Applying to the index only. Staging takes the index→worktree patch forward; unstaging takes
     * the HEAD→index patch backward, which reverts just that hunk in the index and leaves the
     * working tree alone either way.
     */
    await runGitOrThrow(
        request.folder,
        [
            'apply',
            '--cached',
            '--whitespace=nowarn',
            ...(request.side === GitDiffSide.Staged ? ['--reverse'] : []),
            '-',
        ],
        patch,
    );
}

/**
 * Throw away one hunk's change instead of moving it. See {@link discardApplyArgsBySide} for which
 * trees that touches.
 *
 * The patch carries no context lines, unlike a staged one. Context is taken from the old side, and
 * a discard applies against the new side — so a second change within three lines of this one would
 * put its old text in the context and fail the apply. Zero context needs `--unidiff-zero`, which
 * turns off the same safety check that context would have provided; the line numbers come from the
 * diff the user is looking at, and a stale one still fails on the `-` lines not matching.
 */
export async function discardHunkChanges(request: HunkRequest): Promise<void> {
    const patch = await buildSideHunkPatch({
        ...request,
        contextLines: 0,
    });
    await runGitOrThrow(
        request.folder,
        [
            'apply',
            '--whitespace=nowarn',
            '--unidiff-zero',
            '--reverse',
            ...discardApplyArgsBySide[request.side],
            '-',
        ],
        patch,
    );
}
