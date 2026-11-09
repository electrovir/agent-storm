// cspell:words unstaging

import {GitDiffSide, type GitDiffFile, type GitDiffStatus} from '@agent-storm/common';
import {check} from '@augment-vir/assert';

/** The status list each side's files are read from. */
export const statusFilesKeys = {
    [GitDiffSide.Staged]: 'staged',
    [GitDiffSide.Unstaged]: 'unstaged',
} as const satisfies Record<GitDiffSide, keyof GitDiffStatus>;

/**
 * Whether a side's changes can be thrown away from the diff pane. Staged changes can't: unstaging
 * is the way back out of the index, and it loses nothing.
 */
export const canDiscardSide: Readonly<Record<GitDiffSide, boolean>> = {
    [GitDiffSide.Staged]: false,
    [GitDiffSide.Unstaged]: true,
};

/**
 * Dropdown values have to be plain strings, so a file's identity (which side it's on plus its path)
 * is packed into one. NUL can't occur in either half, which keeps the split unambiguous.
 */
const selectValueSeparator = '\0';

export function toSelectValue(side: GitDiffSide, path: string) {
    return [
        side,
        path,
    ].join(selectValueSeparator);
}

/** The reverse of {@link toSelectValue}. `side` is undefined when the value names no known side. */
function extractSelectValue(value: string) {
    const [
        side,
        path,
    ] = value.split(selectValueSeparator);
    return {
        side: check.isEnumValue(side, GitDiffSide) ? side : undefined,
        path,
    };
}

export type SelectedFile = {
    side: GitDiffSide;
    file: GitDiffFile;
};

export function findSelected(
    status: Readonly<GitDiffStatus> | undefined,
    value: string | undefined,
): SelectedFile | undefined {
    if (!status || !value) {
        return undefined;
    }
    const {side, path} = extractSelectValue(value);
    const file = side && status[statusFilesKeys[side]].find((entry) => entry.path === path);
    return side && file
        ? {
              side,
              file,
          }
        : undefined;
}

/**
 * Status as it reads once `moves` have crossed the index, so a stage click shows its result before
 * git confirms it. A file already on the far side keeps that entry, so a partly staged file's line
 * counts stay stale until git is read again.
 */
export function withFilesMoved(
    status: Readonly<GitDiffStatus>,
    moves: ReadonlyArray<SelectedFile>,
): GitDiffStatus {
    function remaining(side: GitDiffSide, files: ReadonlyArray<GitDiffFile>) {
        return files.filter((file) => {
            return !moves.some((move) => move.side === side && move.file.path === file.path);
        });
    }
    function arrivals(from: GitDiffSide, existing: ReadonlyArray<GitDiffFile>) {
        return moves
            .filter((move) => {
                return move.side === from && !existing.some((file) => file.path === move.file.path);
            })
            .map((move) => move.file);
    }
    const staged = remaining(GitDiffSide.Staged, status.staged);
    const unstaged = remaining(GitDiffSide.Unstaged, status.unstaged);
    return {
        staged: [
            ...staged,
            ...arrivals(GitDiffSide.Unstaged, staged),
        ],
        unstaged: [
            ...unstaged,
            ...arrivals(GitDiffSide.Staged, unstaged),
        ],
    };
}

/** Flat, ordered list of every file across both sides — the order the file-jump buttons walk. */
export function allSelectValues(status: Readonly<GitDiffStatus> | undefined): string[] {
    if (!status) {
        return [];
    }
    return [
        ...status.staged.map((file) => toSelectValue(GitDiffSide.Staged, file.path)),
        ...status.unstaged.map((file) => toSelectValue(GitDiffSide.Unstaged, file.path)),
    ];
}

/**
 * Pick the selection to carry into a freshly read status. Exact match wins. Failing that, the same
 * path on the other side does: staging a file removes its unstaged entry and adds a staged one, and
 * the user staged it while reading it, so following it across is what keeps their place. Only a
 * path that is gone from both sides — fully staged and committed, or discarded — falls back to the
 * first file, so the pane never shows a diff for a file that no longer has one.
 */
export function reselectValue(
    previousValue: string | undefined,
    values: ReadonlyArray<string>,
): string | undefined {
    if (!previousValue || values.includes(previousValue)) {
        return previousValue || values[0];
    }
    const previousPath = extractSelectValue(previousValue).path;
    return values.find((value) => extractSelectValue(value).path === previousPath) || values[0];
}

/**
 * The file to open after moving `selected` across the index: the neighbor that slides into its
 * place in that side's list, so a run of Stage clicks walks the list rather than following each
 * file over to the other side. Undefined when it was that side's only file, where
 * {@link reselectValue}'s follow-across is all that's left to do.
 */
export function nextSideValue(
    status: Readonly<GitDiffStatus> | undefined,
    selected: Readonly<SelectedFile>,
): string | undefined {
    const files = status?.[statusFilesKeys[selected.side]];
    if (!files) {
        return undefined;
    }
    const index = files.findIndex((file) => file.path === selected.file.path);
    const remaining = files.filter((file) => file.path !== selected.file.path);
    const next = remaining[Math.min(index, remaining.length - 1)];
    return next && toSelectValue(selected.side, next.path);
}

/** One section of the file menu. Empty sides are dropped before rendering. */
export type FileMenuGroup = {
    side: GitDiffSide;
    files: ReadonlyArray<GitDiffFile>;
};

export function toMenuGroups(status: Readonly<GitDiffStatus> | undefined): FileMenuGroup[] {
    if (!status) {
        return [];
    }
    return [
        {
            side: GitDiffSide.Staged,
            files: status.staged,
        },
        {
            side: GitDiffSide.Unstaged,
            files: status.unstaged,
        },
    ].filter((group) => group.files.length);
}
