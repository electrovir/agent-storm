import {
    addReviewCommentEndpoint,
    deleteReviewCommentEndpoint,
    gitDiffFileEndpoint,
    gitDiffStatusEndpoint,
    gitDiscardFileEndpoint,
    gitDiscardHunkEndpoint,
    gitDiscardUnstagedEndpoint,
    gitStageAllEndpoint,
    gitStageFileEndpoint,
    gitStageHunkEndpoint,
    readReviewCommentsEndpoint,
    settingsEndpoint,
    updateReviewCommentEndpoint,
    type DiffLayout,
    type GitDiffSide,
} from '@agent-storm/common';
import {fetchApi} from '@agent-storm/core/frontend';
import {awaitedForEach, extractErrorMessage} from '@augment-vir/common';
import {type Text} from '@codemirror/state';
import {HttpMethod} from '@rest-vir/api';
import {type SelectedFile} from '../../util/diff-status.js';
import {toLineRange, type SelectedChunk} from './diff-selection.js';

/**
 * An open right-click menu: where the pointer was, in viewport coordinates, what the selection
 * under it covers, and the file and texts the chunks were built from. Carrying the file is what
 * lets the stacked review open the menu for any of its files, not just the selected one.
 */
export type HunkMenu = Readonly<{
    x: number;
    y: number;
    selections: ReadonlyArray<SelectedChunk>;
    target: SelectedFile;
    oldText: Text;
    newText: Text;
}>;

/** A failed read comes back as its message rather than a throw. */
export async function readStatus(folder: string) {
    try {
        return {
            status: await fetchApi(gitDiffStatusEndpoint, HttpMethod.Post, {
                requestData: {
                    folder,
                },
            }),
        };
    } catch (error) {
        return {
            error: extractErrorMessage(error),
        };
    }
}

/**
 * Undefined when the read fails. Commenting is an extra, so a failed read leaves the last comments
 * in place.
 */
export async function readReviewComments(folder: string) {
    try {
        return (
            await fetchApi(readReviewCommentsEndpoint, HttpMethod.Post, {
                requestData: {
                    folder,
                },
            })
        ).comments;
    } catch {
        return undefined;
    }
}

/** A failed read comes back as its message rather than a throw. */
export async function readDiffFile({
    folder,
    selected,
    allowLarge,
}: Readonly<{
    folder: string;
    selected: Readonly<SelectedFile>;
    allowLarge: boolean;
}>) {
    try {
        return {
            diffContent: await fetchApi(gitDiffFileEndpoint, HttpMethod.Post, {
                requestData: {
                    folder,
                    path: selected.file.path,
                    oldPath: selected.file.oldPath ?? undefined,
                    side: selected.side,
                    allowLarge,
                },
            }),
        };
    } catch (error) {
        return {
            error: extractErrorMessage(error),
        };
    }
}

/** Writes the toolbar choices into the user's settings, leaving every other setting as it is. */
export async function writeDiffSettings(
    settings: Readonly<{
        diffLayout: DiffLayout;
        hideWhitespace: boolean;
        collapseUnchanged: boolean;
    }>,
) {
    const currentSettings = await fetchApi(settingsEndpoint, HttpMethod.Get);
    await fetchApi(settingsEndpoint, HttpMethod.Put, {
        requestData: {
            ...currentSettings,
            diffLayout: settings.diffLayout,
            diffHideWhitespace: settings.hideWhitespace,
            diffCollapseUnchanged: settings.collapseUnchanged,
        },
    });
}

/** Each file moves in the direction its own side implies. */
export async function stageFiles({
    folder,
    targets,
}: Readonly<{
    folder: string;
    targets: ReadonlyArray<SelectedFile>;
}>) {
    /** Sequential because git takes `index.lock` for each write. */
    await awaitedForEach(targets, async (target) => {
        await fetchApi(gitStageFileEndpoint, HttpMethod.Post, {
            requestData: {
                folder,
                path: target.file.path,
                side: target.side,
            },
        });
    });
}

export async function stageSide({folder, side}: Readonly<{folder: string; side: GitDiffSide}>) {
    await fetchApi(gitStageAllEndpoint, HttpMethod.Post, {
        requestData: {
            folder,
            side,
        },
    });
}

export async function discardUnstaged(folder: string) {
    await fetchApi(gitDiscardUnstagedEndpoint, HttpMethod.Post, {
        requestData: {
            folder,
        },
    });
}

/** Throws away both the staged and unstaged changes to each path. */
export async function discardFiles({
    folder,
    paths,
}: Readonly<{
    folder: string;
    paths: ReadonlyArray<string>;
}>) {
    /** Sequential because git takes `index.lock` for each write. */
    await awaitedForEach(paths, async (path) => {
        await fetchApi(gitDiscardFileEndpoint, HttpMethod.Post, {
            requestData: {
                folder,
                path,
            },
        });
    });
}

export const discardUnstagedPrompt = [
    'Discard every unstaged change in this repo?',
    'This throws away every change that is not staged, deletes untracked files, and cannot be undone. Staged changes are left alone.',
].join('\n\n');

/**
 * Names every file, since a bulk discard is the one action in the pane where a stray marked row
 * costs the user work they can't get back.
 */
export function toDiscardFilesPrompt(
    paths: Readonly<
        [
            string,
            ...string[],
        ]
    >,
) {
    return [
        paths.length === 1
            ? `Discard all changes to ${paths[0]}?`
            : [
                  `Discard all changes to these ${paths.length} files?`,
                  ...paths,
              ].join('\n'),
        'This throws away both staged and unstaged changes and cannot be undone.',
    ].join('\n\n');
}

/**
 * The arguments both hunk endpoints take. Chunk offsets are character positions and the endpoints
 * address lines. Converting here (rather than server-side) keeps the server from having to re-run
 * the same diff. The old side has to be the same text the chunks were built from — folding
 * whitespace rewrites line contents, so character offsets only line up against the folded copy.
 *
 * A narrowed selection replaces the new side's range and leaves the old side's alone. That only
 * ever happens for a pure insertion, whose old side is the single point the lines go in at — the
 * same point whichever of them the user picked.
 */
function toHunkRequest({
    selection,
    menu,
    folder,
}: Readonly<{
    selection: Readonly<SelectedChunk>;
    menu: HunkMenu;
    folder: string;
}>) {
    const oldLines = toLineRange({
        text: menu.oldText,
        from: selection.chunk.fromA,
        to: selection.chunk.toA,
    });
    const newLines =
        selection.newLines ??
        toLineRange({
            text: menu.newText,
            from: selection.chunk.fromB,
            to: selection.chunk.toB,
        });
    return {
        folder,
        path: menu.target.file.path,
        oldPath: menu.target.file.oldPath ?? undefined,
        side: menu.target.side,
        fromOldLine: oldLines.from,
        toOldLine: oldLines.to,
        fromNewLine: newLines.from,
        toNewLine: newLines.to,
    };
}

/**
 * One request per chunk, bottom of the file upwards. Each request's line numbers were computed
 * against the file as it is now, and writing a chunk shifts every line below it — so working
 * upwards leaves the ranges still to be written untouched, where working downwards would apply the
 * second patch at the wrong offset. Send them in order, one at a time.
 */
export function toHunkRequests({menu, folder}: Readonly<{menu: HunkMenu; folder: string}>) {
    return menu.selections
        .toSorted((first, second) => second.chunk.fromB - first.chunk.fromB)
        .map((selection) => {
            return toHunkRequest({
                selection,
                menu,
                folder,
            });
        });
}

/** Sends `requests` from {@link toHunkRequests} in order, one at a time for `index.lock`. */
export async function writeHunks({
    requests,
    shouldDiscard,
}: Readonly<{
    requests: ReadonlyArray<ReturnType<typeof toHunkRequest>>;
    /** Throw the chunks away instead of moving them across the index. */
    shouldDiscard: boolean;
}>) {
    await awaitedForEach(requests, async (request) => {
        await fetchApi(
            shouldDiscard ? gitDiscardHunkEndpoint : gitStageHunkEndpoint,
            HttpMethod.Post,
            {
                requestData: request,
            },
        );
    });
}

/**
 * Adds a comment, or updates the existing one when `commentId` is set.
 *
 * @returns The folder's whole comment list after the write.
 */
export async function saveReviewComment({
    folder,
    draft,
}: Readonly<{
    folder: string;
    draft: Readonly<{
        commentId: string | undefined;
        path: string;
        line: number;
        body: string;
    }>;
}>) {
    if (draft.commentId) {
        return (
            await fetchApi(updateReviewCommentEndpoint, HttpMethod.Post, {
                requestData: {
                    folder,
                    id: draft.commentId,
                    body: draft.body.trim(),
                },
            })
        ).comments;
    }
    return (
        await fetchApi(addReviewCommentEndpoint, HttpMethod.Post, {
            requestData: {
                folder,
                path: draft.path,
                line: draft.line,
                body: draft.body.trim(),
            },
        })
    ).comments;
}

/** @returns The folder's whole comment list after the delete. */
export async function deleteReviewComment({folder, id}: Readonly<{folder: string; id: string}>) {
    return (
        await fetchApi(deleteReviewCommentEndpoint, HttpMethod.Post, {
            requestData: {
                folder,
                id,
            },
        })
    ).comments;
}
