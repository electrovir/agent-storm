// cspell:words Meslo, Menlo

import {
    GitFileChange,
    type GitDiffFile,
    type GitDiffFileContents,
    type GitDiffSide,
} from '@agent-storm/common';
import {awaitedBlockingMap, typedObjectFromEntries} from '@augment-vir/common';
import {css, defineElement, defineElementEvent, html, listen, unsafeCSS} from 'element-vir';
import {LoaderAnimated24Icon, ViraIcon, viraThemeByKeys} from 'vira';
import {getGitDiffFile} from '../../util/api-client.js';
import {reportRenderError} from '../../util/client-error-log.js';
import {colorsFor} from '../../util/diff-colors.js';
import {
    DiffLineType,
    foldWhitespaceOnlyChanges,
    toDiffHunks,
    type DiffHunkLine,
} from '../../util/diff-hunks.js';
import {toFileIconUrl} from '../../util/file-icon.js';

/**
 * Rendered lines one file contributes before the rest is cut off. A file rewritten end to end is a
 * few thousand rows on its own, and the point of this view is to scroll through every file's
 * changes — one of them turning the whole list to treacle defeats it.
 */
const maxRenderedLinesPerFile = 2000;

const linePrefixes: Readonly<Record<DiffLineType, string>> = {
    [DiffLineType.Context]: ' ',
    [DiffLineType.Added]: '+',
    [DiffLineType.Removed]: '-',
};

/**
 * Identity of what the loaded contents were read for. Line counts are in it, so an agent editing a
 * file already on screen re-reads that file's diff on the next poll — the paths alone would not
 * change.
 */
function toContentKey(files: ReadonlyArray<GitDiffFile>): string {
    return files
        .map((file) =>
            [
                file.path,
                file.change,
                file.insertions,
                file.deletions,
            ].join(':'),
        )
        .join('\n');
}

/**
 * Every changed file on one side, stacked in one scroll: each file's hunks and nothing else, the
 * way a pull request review reads. Deliberately not an editor — no expanding the context, no
 * staging, no syntax highlighting — because this view is for reading a whole change set in order,
 * and the pane's per-file diff is a click away for anything more.
 */
export const VirDiffReview = defineElement<{
    folder: string;
    side: GitDiffSide;
    files: ReadonlyArray<GitDiffFile>;
    /** Matches the pane's toolbar toggle, so both views hide the same whitespace-only edits. */
    hideWhitespace: boolean;
    isDark: boolean;
}>()({
    tagName: 'vir-diff-review',
    options: {
        errorHandler: reportRenderError,
    },
    events: {
        /** A file's header was clicked: the pane opens that file in its own diff. */
        fileSelected: defineElementEvent<string>(),
    },
    state() {
        return {
            contents: {} as Readonly<Record<string, GitDiffFileContents | undefined>>,
            /** {@link toContentKey} of the last read that was started, loaded or still loading. */
            loadedKey: undefined as string | undefined,
            loading: false,
        };
    },
    styles: css`
        :host {
            display: flex;
            flex-direction: column;
            flex-grow: 1;
            min-width: 0;
            min-height: 0;
            overflow: auto;
        }

        .file {
            display: flex;
            flex-direction: column;
            flex-grow: 0;
            flex-shrink: 0;
            border-bottom: 1px solid
                ${viraThemeByKeys.grey['behind-bg'].decoration.background.value};
        }

        /*
         * Sticky so the file a hunk belongs to is still named after scrolling a few hundred lines
         * into it, which is the one thing a stacked review view loses over a per-file pane.
         */
        .file-header {
            position: sticky;
            top: 0;
            z-index: 1;
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 6px 10px;
            appearance: none;
            border: none;
            border-bottom: 1px solid
                ${viraThemeByKeys.grey['behind-bg'].decoration.background.value};
            cursor: pointer;
            font: inherit;
            text-align: left;
            background: ${viraThemeByKeys.grey['behind-fg'].body.background.value};
            color: inherit;
        }

        .file-header:hover .file-path {
            color: ${viraThemeByKeys.blue.foreground.body.foreground.value};
        }

        .file-icon {
            flex-grow: 0;
            flex-shrink: 0;
            width: 16px;
            height: 16px;
        }

        .file-path {
            flex-grow: 1;
            min-width: 0;
            overflow: hidden;
            white-space: nowrap;
            text-overflow: ellipsis;
            font-family: 'MesloLGS NF', Menlo, monospace;
            font-size: 11px;

            &[data-deleted] {
                text-decoration: line-through;
            }
        }

        .file-stats {
            flex-grow: 0;
            flex-shrink: 0;
            font-size: 11px;
            font-family: 'MesloLGS NF', Menlo, monospace;
        }

        .insertions {
            color: ${viraThemeByKeys.green.foreground.body.foreground.value};
        }

        .deletions {
            color: ${viraThemeByKeys.red.foreground.body.foreground.value};
        }

        /* Long lines scroll within their own file rather than stretching the whole review. */
        .hunks {
            display: flex;
            flex-direction: column;
            overflow-x: auto;
            font-family: 'MesloLGS NF', Menlo, monospace;
            font-size: 10px;
        }

        .hunk-header {
            padding: 2px 8px;
            white-space: pre;
            color: ${viraThemeByKeys.grey.foreground['non-body'].foreground.value};
            background: ${viraThemeByKeys.grey['behind-bg'].invisible.background.value};
        }

        .line {
            display: flex;
            align-items: baseline;
            white-space: pre;

            &[data-type='${unsafeCSS(DiffLineType.Added)}'] {
                background: var(--diff-added-line);
            }

            &[data-type='${unsafeCSS(DiffLineType.Removed)}'] {
                background: var(--diff-removed-line);
            }
        }

        .line-number {
            flex-grow: 0;
            flex-shrink: 0;
            width: 5ch;
            padding: 0 4px;
            text-align: right;
            user-select: none;
            color: ${viraThemeByKeys.grey.foreground.placeholder.foreground.value};
        }

        .line-text {
            flex-grow: 1;
            padding-right: 8px;
        }

        .note {
            padding: 8px 10px;
            font-size: 11px;
            color: ${viraThemeByKeys.grey.foreground['non-body'].foreground.value};
        }

        .loading {
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 16px;
        }
    `,
    render({inputs, state, updateState, host, dispatch, events}) {
        host.style.setProperty('--diff-added-line', colorsFor(inputs.isDark).addedLine);
        host.style.setProperty('--diff-removed-line', colorsFor(inputs.isDark).removedLine);

        const contentKey = toContentKey(inputs.files);
        if (state.loadedKey !== contentKey) {
            updateState({
                loadedKey: contentKey,
                loading: true,
            });
            /**
             * Sequential: a review of a large change set would otherwise fire a git read per file
             * at once, and the whole list is useless until the slowest of them lands anyway.
             */
            void awaitedBlockingMap(inputs.files, async (file) => {
                const content = await getGitDiffFile({
                    folder: inputs.folder,
                    path: file.path,
                    oldPath: file.oldPath ?? undefined,
                    side: inputs.side,
                    allowLarge: false,
                }).catch(() => undefined);
                return [
                    file.path,
                    content,
                ] as const;
            }).then((entries) => {
                /** A newer read started while this one ran, and its results are the current ones. */
                if (state.loadedKey === contentKey) {
                    updateState({
                        contents: typedObjectFromEntries(entries),
                        loading: false,
                    });
                }
            });
        }

        const renderLine = (line: Readonly<DiffHunkLine>) => html`
            <div class="line" data-type=${line.type}>
                <span class="line-number">${line.oldLineNumber ?? ''}</span>
                <span class="line-number">${line.newLineNumber ?? ''}</span>
                <span class="line-text">${linePrefixes[line.type]}${line.text}</span>
            </div>
        `;

        const renderFileBody = (file: Readonly<GitDiffFile>) => {
            const content = state.contents[file.path];
            if (!content) {
                return html`
                    <div class="note">
                        ${state.loading ? 'Loading…' : 'Could not read this file’s diff.'}
                    </div>
                `;
            } else if (content.isImage) {
                return html`
                    <div class="note">Image change — open the file to see it.</div>
                `;
            } else if (content.tooLargeOrBinary) {
                return html`
                    <div class="note">Binary or oversized file — no diff shown.</div>
                `;
            }
            const lines = toDiffHunks({
                oldContent: inputs.hideWhitespace
                    ? foldWhitespaceOnlyChanges({
                          oldContent: content.oldContent,
                          newContent: content.newContent,
                      })
                    : content.oldContent,
                newContent: content.newContent,
            }).flatMap((hunk) => [
                {
                    header: hunk.header,
                },
                ...hunk.lines,
            ]);
            if (!lines.length) {
                return html`
                    <div class="note">Only whitespace changed.</div>
                `;
            }
            return html`
                <div class="hunks">
                    ${lines.slice(0, maxRenderedLinesPerFile).map((line) =>
                        'header' in line
                            ? html`
                                  <div class="hunk-header">${line.header}</div>
                              `
                            : renderLine(line),
                    )}
                </div>
                ${lines.length > maxRenderedLinesPerFile
                    ? html`
                          <div class="note">
                              ${lines.length - maxRenderedLinesPerFile} more lines — open the file
                              to read the rest.
                          </div>
                      `
                    : ''}
            `;
        };

        if (!inputs.files.length) {
            return html`
                <div class="note">Nothing to review on this side.</div>
            `;
        }

        return html`
            ${inputs.files.map(
                (file) => html`
                    <div class="file">
                        <button
                            type="button"
                            class="file-header"
                            title=${`Open ${file.path}`}
                            ${listen('click', () => {
                                dispatch(new events.fileSelected(file.path));
                            })}
                        >
                            <img class="file-icon" src=${toFileIconUrl(file.path)} alt="" />
                            <span
                                class="file-path"
                                ?data-deleted=${file.change === GitFileChange.Deleted}
                            >
                                ${file.path}
                            </span>
                            <span class="file-stats">
                                <span class="insertions">+${file.insertions}</span>
                                <span class="deletions">−${file.deletions}</span>
                            </span>
                        </button>
                        ${renderFileBody(file)}
                    </div>
                `,
            )}
            ${state.loading
                ? html`
                      <div class="loading">
                          <${ViraIcon.assign({
                              icon: LoaderAnimated24Icon,
                          })}></${ViraIcon}>
                      </div>
                  `
                : ''}
        `;
    },
});
