// cspell:words numstat unstaging nowarn unidiff apng docx dylib flac heic heif mkv odp ods odt pptx pyc sqlite tgz tiff ttf woff xlsx

import {
    GitDiffSide,
    GitFileChange,
    maxDiffFileBytes,
    maxDiffFileLines,
    maxDiffImageBytes,
    type PluginCallRequest,
} from '@agent-storm/common';
import {check} from '@augment-vir/assert';
import {
    awaitedForEach,
    extractErrorMessage,
    extractExtension,
    filterMap,
    retry,
    typedObjectFromEntries,
} from '@augment-vir/common';
import {doesPathContain} from '@augment-vir/node';
import {
    extractCommandStderr,
    gitTimeout,
    hasErrorCode,
    readOnlyGitEnv,
    runCommand,
} from 'agent-storm-util';
import {convertDuration} from 'date-vir';
import {execFile} from 'node:child_process';
import {readFile, rm} from 'node:fs/promises';
import {isAbsolute, resolve} from 'node:path';
import {promisify} from 'node:util';
import {type diffApi, type GitDiffStatus} from '../diff-api.js';

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
    const result = await runCommand('git', [...args], {
        cwd: folder,
        maxBuffer: gitMaxBuffer,
        env: readOnlyGitEnv,
        timeout: gitTimeout,
    }).catch(() => undefined);
    return result?.stdout;
}

/**
 * Run a git command that is expected to succeed, surfacing git's own stderr on failure. Used for
 * the index-mutating calls, where a silent no-op would leave the user staring at an unchanged pane
 * with no explanation.
 *
 * Retried while `index.lock` is held: any other git process in the checkout (an agent's or an
 * editor's `git status`) holds it for the moment its own call takes, and a write that hits it fails
 * without changing anything.
 */
async function runGitOrThrow(
    folder: string,
    args: ReadonlyArray<string>,
    stdin?: string | undefined,
): Promise<void> {
    const failure = await retry(
        10,
        async () => {
            const stderr = await runCommand('git', [...args], {
                cwd: folder,
                maxBuffer: gitMaxBuffer,
                stdin,
                timeout: gitTimeout,
            }).then(
                () => undefined,
                (error: unknown) => extractCommandStderr(error),
            );
            /** Thrown only so `retry` tries again; every other failure is returned as final. */
            if (stderr?.includes('index.lock')) {
                throw new Error(stderr);
            }
            return stderr;
        },
        {
            interval: {
                milliseconds: 100,
            },
        },
    ).catch((error: unknown) => extractErrorMessage(error));
    if (failure) {
        throw new Error(`git ${args[0]} failed: ${failure}`);
    }
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

const statusChangeKeys = {
    [GitDiffSide.Staged]: 'stagedChange',
    [GitDiffSide.Unstaged]: 'unstagedChange',
} as const satisfies Record<IndexSide, keyof StatusEntry>;

/**
 * Parse `git status --porcelain=v1 -z`. Records are NUL-terminated `XY <path>`; a rename or copy
 * record is followed by one extra NUL-terminated field holding the original path.
 */
function parseStatus(raw: string): StatusEntry[] {
    const records = raw
        .split('\0')
        .filter((record) => record)
        .values();
    return Array.from(records, (record) => {
        const indexLetter = record.slice(0, 1);
        const worktreeLetter = record.slice(1, 2);
        const isRenameOrCopy = indexLetter === 'R' || indexLetter === 'C';
        return {
            path: record.slice(3),
            oldPath: isRenameOrCopy ? records.next().value : undefined,
            /**
             * `?` in the index column means untracked, which is an unstaged-only state — there is
             * nothing in the index to compare against yet.
             */
            stagedChange:
                indexLetter === ' ' || indexLetter === '?'
                    ? undefined
                    : changeFromStatusLetter(indexLetter),
            unstagedChange:
                worktreeLetter === ' ' ? undefined : changeFromStatusLetter(worktreeLetter),
        };
    });
}

async function readStatusEntries(folder: string) {
    const status = await runGitText(folder, [
        'status',
        '--porcelain=v1',
        '-z',
        '--untracked-files=all',
    ]);
    return parseStatus(status || '');
}

async function readChangedPaths({folder, side}: Readonly<{folder: string; side: IndexSide}>) {
    return filterMap(
        await readStatusEntries(folder),
        (entry) => entry[statusChangeKeys[side]] && entry.path,
        check.isTruthy,
    );
}

/**
 * Parse `git diff --numstat -z`. Renames leave the path empty and put the old and new paths in the
 * next two NUL-separated fields. Binary files report `-` for both counts, which becomes `0`.
 */
function parseNumstat(
    raw: string,
): Partial<Record<string, {insertions: number; deletions: number}>> {
    const records = raw
        .split('\0')
        .filter((record) => record)
        .values();
    return typedObjectFromEntries(
        Array.from(records, (record) => {
            const [
                insertionsRaw,
                deletionsRaw,
                ...pathParts
            ] = record.split('\t');
            const pathInRecord = pathParts.join('\t');
            if (!pathInRecord) {
                records.next();
            }
            const path = pathInRecord || records.next().value;
            return path
                ? ([
                      path,
                      {
                          insertions: Number(insertionsRaw) || 0,
                          deletions: Number(deletionsRaw) || 0,
                      },
                  ] as const)
                : undefined;
        }).filter(check.isTruthy),
    );
}

export async function getDiffStatus(folder: string): Promise<GitDiffStatus> {
    const [
        entries,
        stagedNumstatRaw,
        unstagedNumstatRaw,
    ] = await Promise.all([
        readStatusEntries(folder),
        /** Git compares against an empty tree before the first commit when no commit is supplied. */
        runGitText(folder, [
            'diff',
            '--numstat',
            '-z',
            '--no-renames',
            '--cached',
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

    if (!entries.length) {
        return {
            staged: [],
            unstaged: [],
            pullRequest: [],
        };
    }

    function filesForSide(side: IndexSide, counts: ReturnType<typeof parseNumstat>) {
        return filterMap(
            entries,
            (entry) => {
                const change = entry[statusChangeKeys[side]];
                if (!change) {
                    return undefined;
                }
                return {
                    path: entry.path,
                    change,
                    oldPath: entry.oldPath,
                    insertions: counts[entry.path]?.insertions ?? 0,
                    deletions: counts[entry.path]?.deletions ?? 0,
                };
            },
            check.isTruthy,
        );
    }

    return {
        staged: filesForSide(GitDiffSide.Staged, parseNumstat(stagedNumstatRaw || '')),
        unstaged: filesForSide(GitDiffSide.Unstaged, parseNumstat(unstagedNumstatRaw || '')),
        pullRequest: [],
    };
}

/**
 * Parse `git diff --name-status -z`. Records are a status letter (with a similarity score after a
 * rename's `R`) then the path, and a rename's record carries its old path before its new one.
 */
function parseNameStatus(raw: string) {
    const fields = raw
        .split('\0')
        .filter((field) => field)
        .values();
    return Array.from(fields, (field) => {
        const letter = field.slice(0, 1);
        const isRenameOrCopy = letter === 'R' || letter === 'C';
        const oldPath = isRenameOrCopy ? fields.next().value : undefined;
        return {
            path: fields.next().value || '',
            oldPath,
            change: changeFromStatusLetter(letter),
        };
    });
}

/**
 * Each folder's PR status by base branch, with the two commits it compares. Mutated in place: a
 * cache that lives as long as the server.
 */
const pullRequestStatuses = new Map<
    string,
    Readonly<{
        headCommit: string;
        baseCommit: string;
        status: Promise<GitDiffStatus>;
    }>
>();

/**
 * The files a PR into `baseBranch` changes, the way GitHub lists them: committed changes since the
 * merge base, so uncommitted work is left to {@link getDiffStatus}. The remote-tracking branch wins
 * over a local one because the PR merges into the remote, and a local base branch is often stale.
 */
export async function getPullRequestStatus({
    folder,
    baseBranch,
}: Readonly<{folder: string; baseBranch: string}>): Promise<GitDiffStatus> {
    /** Each starts with `refs/`, so a branch name can't be read as an option. */
    const [
        headCommit,
        ...baseCommits
    ] = await Promise.all(
        [
            'HEAD',
            `refs/remotes/origin/${baseBranch}`,
            `refs/heads/${baseBranch}`,
        ].map(async (ref) => {
            return (
                await runGitText(folder, [
                    'rev-parse',
                    '--verify',
                    '--quiet',
                    `${ref}^{commit}`,
                ])
            )?.trim();
        }),
    );
    const baseCommit = baseCommits.find(check.isTruthy);
    if (!baseCommit) {
        throw new Error(
            `Branch '${baseBranch}' isn't in this repo. Fetch it to see the PR's diff.`,
        );
    } else if (!headCommit) {
        throw new Error(`This branch shares no history with '${baseBranch}'.`);
    }
    /**
     * The status only depends on the two commits, and the diff pane polls it, so the `merge-base`
     * and diffs (seconds in a big repo) only run again once either commit moves.
     */
    const key = `${folder}\0${baseBranch}`;
    const cached = pullRequestStatuses.get(key);
    if (cached?.headCommit === headCommit && cached.baseCommit === baseCommit) {
        return await cached.status;
    }
    const entry = {
        headCommit,
        baseCommit,
        status: diffCommits({
            folder,
            baseBranch,
            baseCommit,
            headCommit,
        }),
    };
    pullRequestStatuses.set(key, entry);
    entry.status.catch(() => {
        if (pullRequestStatuses.get(key) === entry) {
            pullRequestStatuses.delete(key);
        }
    });
    return await entry.status;
}

async function diffCommits({
    folder,
    baseBranch,
    baseCommit,
    headCommit,
}: Readonly<{folder: string; baseBranch: string; baseCommit: string; headCommit: string}>) {
    const mergeBase = (
        await runGitText(folder, [
            'merge-base',
            baseCommit,
            headCommit,
        ])
    )?.trim();
    if (!mergeBase) {
        throw new Error(`This branch shares no history with '${baseBranch}'.`);
    }
    const [
        nameStatusRaw,
        numstatRaw,
    ] = await Promise.all([
        runGitText(folder, [
            'diff',
            '--name-status',
            '-z',
            '--find-renames',
            mergeBase,
            headCommit,
            '--',
        ]),
        runGitText(folder, [
            'diff',
            '--numstat',
            '-z',
            '--find-renames',
            mergeBase,
            headCommit,
            '--',
        ]),
    ]);
    if (nameStatusRaw == undefined) {
        throw new Error(`Failed to diff this branch against '${baseBranch}'.`);
    }
    const counts = parseNumstat(numstatRaw || '');
    return {
        staged: [],
        unstaged: [],
        pullRequest: parseNameStatus(nameStatusRaw).map((file) => {
            return {
                ...file,
                insertions: counts[file.path]?.insertions ?? 0,
                deletions: counts[file.path]?.deletions ?? 0,
            };
        }),
        pullRequestBase: mergeBase,
    } satisfies GitDiffStatus;
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
    return doesPathContain({
        potentialParentPath: folder,
        potentialChildPath: resolved,
    })
        ? resolved
        : undefined;
}

function looksBinary(contents: Readonly<Buffer>): boolean {
    return contents.subarray(0, binarySniffBytes).includes(0);
}

/** Read a blob by git revision spec (`HEAD:path`, `:path`). Empty when the blob doesn't exist. */
async function readBlob({folder, spec}: Readonly<{folder: string; spec: string}>): Promise<Buffer> {
    /** Not {@link runCommand}, which decodes output as text and would mangle a binary blob. */
    const result = await promisify(execFile)(
        'git',
        [
            'show',
            spec,
        ],
        {
            cwd: folder,
            maxBuffer: gitMaxBuffer,
            encoding: 'buffer',
            timeout: convertDuration(gitTimeout, {
                milliseconds: true,
            }).milliseconds,
        },
    ).catch((error: unknown) => {
        if (hasErrorCode(error, 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER')) {
            throw new Error("Git output exceeded the Diff pane's size limit.");
        }
        return undefined;
    });
    return result?.stdout ?? Buffer.alloc(0);
}

/** Whether a blob exists at the given revision spec, distinguishing "empty" from "absent". */
async function blobExists({
    folder,
    spec,
}: Readonly<{folder: string; spec: string}>): Promise<boolean> {
    return await runCommand(
        'git',
        [
            'cat-file',
            '-e',
            spec,
        ],
        {
            cwd: folder,
            timeout: gitTimeout,
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
 * tree, and pull request is `baseCommit` → `HEAD`. A rename only needs its pre-rename path on the
 * sides that start from a commit, because the index already holds the file under its new name by
 * the time the worktree diff is taken.
 */
function specsForSide({
    path,
    oldPath,
    side,
    baseCommit,
}: Readonly<{
    path: string;
    oldPath: string | undefined;
    side: GitDiffSide;
    baseCommit: string | undefined;
}>): SidePaths {
    const bySide: Readonly<Record<GitDiffSide, () => SidePaths>> = {
        [GitDiffSide.Staged]() {
            return {
                oldSpec: `HEAD:${oldPath || path}`,
                newSpec: `:${path}`,
            };
        },
        [GitDiffSide.Unstaged]() {
            return {
                oldSpec: `:${path}`,
                newSpec: undefined,
            };
        },
        [GitDiffSide.PullRequest]() {
            /** Checked because it lands in front of a `git show` argument. */
            if (!baseCommit || !/^[0-9a-f]+$/.test(baseCommit)) {
                throw new Error('A pull request diff needs the commit it compares against.');
            }
            return {
                oldSpec: `${baseCommit}:${oldPath || path}`,
                newSpec: `HEAD:${path}`,
            };
        },
    };
    return bySide[side]();
}

/** The sides the index sits on, which are the only ones a stage or discard can change. */
type IndexSide = Exclude<GitDiffSide, GitDiffSide.PullRequest>;

function assertIndexSide(side: GitDiffSide): asserts side is IndexSide {
    if (side === GitDiffSide.PullRequest) {
        throw new Error('Committed changes cannot be staged or discarded.');
    }
}

async function readSideBuffers({
    folder,
    path,
    oldPath,
    side,
    baseCommit,
}: Readonly<{
    folder: string;
    path: string;
    oldPath: string | undefined;
    side: GitDiffSide;
    baseCommit: string | undefined;
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
        baseCommit,
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

/**
 * Formats the Diff pane shows as pictures. Deliberately raster-only: an SVG diffs usefully as text,
 * and `looksBinary` already lets it through as one.
 */
const imageMimeTypes: Readonly<Record<string, string>> = {
    '.apng': 'image/apng',
    '.avif': 'image/avif',
    '.bmp': 'image/bmp',
    '.gif': 'image/gif',
    '.ico': 'image/x-icon',
    '.jpeg': 'image/jpeg',
    '.jpg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
};

/**
 * Formats that are binary even when their leading {@link binarySniffBytes} bytes contain no NUL, so
 * the sniff alone would hand the pane megabytes of garbled text to render. PDF is the case that
 * motivated the list: it opens with an ASCII header and object table, and a small one can be NUL-
 * free from end to end. Raster formats no browser will render (TIFF, HEIC) belong here too rather
 * than in {@link imageMimeTypes}.
 */
const binaryExtensions: ReadonlyArray<string> = [
    '.7z',
    '.avi',
    '.bin',
    '.bz2',
    '.class',
    '.dll',
    '.dmg',
    '.doc',
    '.docx',
    '.dylib',
    '.eot',
    '.exe',
    '.flac',
    '.gz',
    '.heic',
    '.heif',
    '.iso',
    '.jar',
    '.mkv',
    '.mov',
    '.mp3',
    '.mp4',
    '.node',
    '.odp',
    '.ods',
    '.odt',
    '.ogg',
    '.otf',
    '.pdf',
    '.ppt',
    '.pptx',
    '.psd',
    '.pyc',
    '.rar',
    '.so',
    '.sqlite',
    '.tar',
    '.tgz',
    '.tif',
    '.tiff',
    '.ttf',
    '.wav',
    '.webm',
    '.woff',
    '.woff2',
    '.xls',
    '.xlsx',
    '.xz',
    '.zip',
];

/**
 * Inlined as a `data:` URL rather than served from an endpoint: the old side is a git blob, which
 * has no path a browser could request it from. Empty means the side doesn't exist — an added image
 * has no old blob, a deleted one has no new file.
 */
function toImageDataUrl({
    buffer,
    mimeType,
}: Readonly<{buffer: Readonly<Buffer>; mimeType: string}>): string | undefined {
    return buffer.byteLength ? `data:${mimeType};base64,${buffer.toString('base64')}` : undefined;
}

export async function getDiffFileContents(
    params: Readonly<PluginCallRequest<typeof diffApi, 'readFile'>>,
) {
    const {oldBuffer, newBuffer} = await readSideBuffers({
        ...params,
        oldPath: params.oldPath || undefined,
        baseCommit: params.baseCommit || undefined,
    });

    const extension = extractExtension(params.path).extension.toLowerCase();
    const imageMimeType = imageMimeTypes[extension];
    if (
        imageMimeType &&
        oldBuffer.byteLength <= maxDiffImageBytes &&
        newBuffer.byteLength <= maxDiffImageBytes
    ) {
        return {
            oldContent: '',
            newContent: '',
            isImage: true,
            oldImage: toImageDataUrl({
                buffer: oldBuffer,
                mimeType: imageMimeType,
            }),
            newImage: toImageDataUrl({
                buffer: newBuffer,
                mimeType: imageMimeType,
            }),
            tooLargeOrBinary: false,
            /** Nothing is being withheld, so there is nothing to re-request. */
            canShowAnyway: false,
        };
    }

    const binary =
        binaryExtensions.includes(extension) || looksBinary(oldBuffer) || looksBinary(newBuffer);
    const tooLarge =
        oldBuffer.byteLength > maxDiffFileBytes ||
        newBuffer.byteLength > maxDiffFileBytes ||
        countLines(oldBuffer) > maxDiffFileLines ||
        countLines(newBuffer) > maxDiffFileLines;
    const withheld = binary || (tooLarge && !params.allowLarge);

    return {
        oldContent: withheld ? '' : oldBuffer.toString('utf8'),
        newContent: withheld ? '' : newBuffer.toString('utf8'),
        isImage: false,
        tooLargeOrBinary: withheld,
        canShowAnyway: withheld && !binary,
    };
}

/** Moves one file across the index, away from the side it's on. */
const moveFileFromSide: Readonly<
    Record<IndexSide, (params: Readonly<{folder: string; path: string}>) => Promise<void>>
> = {
    async [GitDiffSide.Unstaged]({folder, path}) {
        /** `-A` is what makes this also stage a deletion rather than only content changes. */
        await runGitOrThrow(folder, [
            'add',
            '-A',
            '--',
            path,
        ]);
    },
    async [GitDiffSide.Staged]({folder, path}) {
        /**
         * `restore --staged` needs a HEAD to restore the index entry from. In a repo with no
         * commits yet there is none, and dropping the index entry entirely is the equivalent
         * operation.
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
    },
};

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
    }
    assertIndexSide(side);
    await moveFileFromSide[side]({
        folder,
        path,
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
    assertIndexSide(side);
    const paths = await readChangedPaths({
        folder,
        side,
    });
    await awaitedForEach(paths, async (path) => {
        await setFileStaged({
            folder,
            path,
            side,
        });
    });
}

/**
 * Throw away one file's unstaged changes, leaving anything staged for it in place. The index entry
 * is the state to return to when there is one; without it — an untracked file, or one whose
 * deletion is already staged — there is nothing to restore, so the file goes.
 */
async function discardUnstagedFileChanges({
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
            spec: `:${path}`,
        })
    ) {
        await runGitOrThrow(folder, [
            'restore',
            '--worktree',
            '--',
            path,
        ]);
        return;
    }
    await rm(absolutePath, {
        force: true,
        recursive: true,
    });
}

/**
 * {@link discardUnstagedFileChanges} for every file `git status` reports as unstaged. Sequential for
 * the same `index.lock` reason {@link setSideStaged} is.
 */
export async function discardUnstagedChanges(folder: string): Promise<void> {
    const paths = await readChangedPaths({
        folder,
        side: GitDiffSide.Unstaged,
    });
    await awaitedForEach(paths, async (path) => {
        await discardUnstagedFileChanges({
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
const discardApplyArgsBySide: Readonly<Record<IndexSide, ReadonlyArray<string>>> = {
    [GitDiffSide.Unstaged]: [],
    [GitDiffSide.Staged]: ['--index'],
};

/**
 * `git apply --cached` args that move a hunk off the given side. Staging takes the index→worktree
 * patch forward; unstaging takes the HEAD→index patch backward, which reverts just that hunk in the
 * index and leaves the working tree alone either way.
 */
const moveApplyArgsBySide: Readonly<Record<IndexSide, ReadonlyArray<string>>> = {
    [GitDiffSide.Unstaged]: [],
    [GitDiffSide.Staged]: ['--reverse'],
};

type HunkRequest = Readonly<PluginCallRequest<typeof diffApi, 'stageHunk'>>;

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
        oldPath: oldPath || undefined,
        side,
        baseCommit: undefined,
    });
    if (looksBinary(oldBuffer) || looksBinary(newBuffer)) {
        throw new Error('Cannot change part of a binary file.');
    }

    const specs = specsForSide({
        path,
        oldPath: oldPath || undefined,
        side,
        baseCommit: undefined,
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
    const side = request.side;
    assertIndexSide(side);
    const patch = await buildSideHunkPatch({
        ...request,
        contextLines: hunkContextLines,
    });
    await runGitOrThrow(
        request.folder,
        [
            'apply',
            '--cached',
            '--whitespace=nowarn',
            ...moveApplyArgsBySide[side],
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
    const side = request.side;
    assertIndexSide(side);
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
            ...discardApplyArgsBySide[side],
            '-',
        ],
        patch,
    );
}
