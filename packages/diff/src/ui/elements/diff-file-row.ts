// cspell:words meslo menlo

import {GitDiffSide, GitFileChange, type GitDiffFile} from '@agent-storm/common';
import {extractExtension} from '@augment-vir/common';
import {css, html, type CSSResult} from 'element-vir';
import {LucideFileStackIcon, createSizedIcon, viraThemeByKeys} from 'vira';
import {toFileIconUrl} from '../../util/file-icon.js';

/** Single-letter badge on each file row, matching git's own status letters. */
export const changeBadges: Readonly<Record<GitFileChange, string>> = {
    [GitFileChange.Added]: 'A',
    [GitFileChange.Modified]: 'M',
    [GitFileChange.Deleted]: 'D',
    [GitFileChange.Renamed]: 'R',
    [GitFileChange.Untracked]: 'U',
};

/**
 * Badge colors. Deletions read red, additions green, everything else stays neutral so a long file
 * list doesn't turn into a color chart.
 */
export const changeBadgeColors: Readonly<Record<GitFileChange, CSSResult>> = {
    [GitFileChange.Added]: viraThemeByKeys.green.foreground.body.foreground.value,
    [GitFileChange.Modified]: viraThemeByKeys.blue.foreground.body.foreground.value,
    [GitFileChange.Deleted]: viraThemeByKeys.red.foreground.body.foreground.value,
    [GitFileChange.Renamed]: viraThemeByKeys.blue.foreground.body.foreground.value,
    [GitFileChange.Untracked]: viraThemeByKeys.grey.foreground['non-body'].foreground.value,
};

/** Opens the whole side's changes as one scrollable review instead of one file at a time. */
export const reviewIcon = createSizedIcon(LucideFileStackIcon, 14);

export const sideLabels: Readonly<Record<GitDiffSide, string>> = {
    [GitDiffSide.Staged]: 'Staged',
    [GitDiffSide.Unstaged]: 'Changed',
};

/** A path's final segment, which is all the file rows show — the full path is their `title`. */
export function basename(path: string) {
    const parts = extractExtension(path);
    return `${parts.basename}${parts.extension}`;
}

export function reviewButtonTitle({
    side,
    reviewSide,
}: Readonly<{
    side: GitDiffSide;
    reviewSide: GitDiffSide | undefined;
}>) {
    return reviewSide === side
        ? 'Back to the single-file diff'
        : `Read every ${sideLabels[side].toLowerCase()} file's changes in one scroll`;
}

/**
 * One file's row contents, shared by the desktop file list and the mobile dropdown. The badge comes
 * last so it sits at the row's right edge, just inside the hover-revealed row actions. The full
 * path is still reachable: it's the row's `title`. Style it with {@link fileRowStyles}.
 */
export function fileRowContents(file: Readonly<GitDiffFile>) {
    return html`
        <img class="file-icon" src=${toFileIconUrl(file.path)} alt="" />
        <span class="file-basename" ?data-deleted=${file.change === GitFileChange.Deleted}>
            ${basename(file.path)}
        </span>
        <span
            class="badge"
            style=${css`
                color: ${changeBadgeColors[file.change]};
            `}
        >
            ${changeBadges[file.change]}
        </span>
    `;
}

export const fileRowStyles = css`
    .file-basename {
        flex-grow: 1;
        min-width: 0;
        overflow: hidden;
        white-space: nowrap;
        text-overflow: ellipsis;

        &[data-deleted] {
            text-decoration: line-through;
        }
    }

    /*
     * Fetched lazily from www-static as rows render, so the whole icon set costs nothing until a
     * file that uses one shows up. Sized in px rather than em to stay pixel-aligned with the
     * source svgs, which are drawn on a 32px grid.
     */
    .file-icon {
        flex-grow: 0;
        flex-shrink: 0;
        width: 16px;
        height: 16px;
    }

    .badge {
        flex-grow: 0;
        flex-shrink: 0;
        width: 1em;
        font-weight: 700;
        font-family: 'MesloLGS NF', Menlo, monospace;
    }
`;
