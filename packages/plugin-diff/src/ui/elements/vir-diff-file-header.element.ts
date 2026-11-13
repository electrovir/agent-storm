// cspell:words meslo menlo

import {GitDiffSide, GitFileChange} from '@agent-storm/common';
import {defineAppElement} from '@agent-storm/core/frontend';
import {css, defineElementEvent, html, listen} from 'element-vir';
import {ViraButton, ViraColorVariant, ViraSize, viraThemeByKeys} from 'vira';
import {type GitDiffFile} from '../../diff-api.js';
import {toFileIconUrl} from '../../util/file-icon.js';

/** What a file's stage button does to a file on this side. */
export const stageActionLabels: Readonly<Record<GitDiffSide, string>> = {
    [GitDiffSide.Staged]: 'Unstage',
    [GitDiffSide.Unstaged]: 'Stage',
};

/** The grey bar over a file's diff: its name and line counts, and its stage button. */
export const VirDiffFileHeader = defineAppElement<{
    file: GitDiffFile;
    side: GitDiffSide;
    /** Makes the name a button that fires `fileSelected`, for a file shown among others. */
    isOpenable: boolean;
}>()({
    tagName: 'vir-diff-file-header',
    events: {
        /** The name was clicked. Only fires while `isOpenable` is set. */
        fileSelected: defineElementEvent<string>(),
        /** The stage button was clicked: the pane moves the whole file across the index. */
        stageFile: defineElementEvent<GitDiffFile>(),
    },
    /**
     * Sticky so the file a hunk belongs to is still named after scrolling a few hundred lines into
     * it, which is the one thing a stacked review loses over a single-file diff.
     */
    styles: css`
        :host {
            position: sticky;
            top: 0;
            z-index: 1;
            display: flex;
            flex-shrink: 0;
            align-items: center;
            gap: 8px;
            padding: 4px 10px;
            border-bottom: 1px solid
                ${viraThemeByKeys.grey['behind-bg'].decoration.background.value};
            background: ${viraThemeByKeys.grey['behind-fg'].body.background.value};
        }

        .file-name {
            display: flex;
            flex-grow: 1;
            align-items: center;
            gap: 8px;
            min-width: 0;
            padding: 2px 0;
        }

        .file-open {
            appearance: none;
            border: none;
            cursor: pointer;
            font: inherit;
            text-align: left;
            background: none;
            color: inherit;

            &:hover .file-path {
                color: ${viraThemeByKeys.blue.foreground.body.foreground.value};
            }
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
    `,
    render({inputs, dispatch, events}) {
        const nameTemplate = html`
            <img class="file-icon" src=${toFileIconUrl(inputs.file.path)} alt="" />
            <span class="file-path" ?data-deleted=${inputs.file.change === GitFileChange.Deleted}>
                ${inputs.file.path}
            </span>
            <span class="file-stats">
                <span class="insertions">+${inputs.file.insertions}</span>
                <span class="deletions">−${inputs.file.deletions}</span>
            </span>
        `;

        return html`
            ${inputs.isOpenable
                ? html`
                      <button
                          type="button"
                          class="file-name file-open"
                          title=${`Open ${inputs.file.path}`}
                          ${listen('click', () => {
                              dispatch(
                                  new events.fileSelected({
                                      detail: inputs.file.path,
                                  }),
                              );
                          })}
                      >
                          ${nameTemplate}
                      </button>
                  `
                : html`
                      <div class="file-name" title=${inputs.file.path}>${nameTemplate}</div>
                  `}
            <${ViraButton.assign({
                text: stageActionLabels[inputs.side],
                buttonSize: ViraSize.Small,
                color: ViraColorVariant.Neutral,
            })}
                title="Move the whole file across the index"
                ${listen('click', () => {
                    dispatch(
                        new events.stageFile({
                            detail: inputs.file,
                        }),
                    );
                })}
            ></${ViraButton}>
        `;
    },
});
