import {maxDiffFileLines, type GitDiffFileContents, type ReviewComment} from '@agent-storm/common';
import {css, defineElementEvent, html, listen, nothing} from 'element-vir';
import {ViraButton, ViraColorVariant, ViraSize, viraThemeByKeys} from 'vira';
import {defineAppElement} from '../define-app-element.js';
import {imageDiffStyles, renderImageDiff} from './image-diff.js';
import {VirFileComments} from './vir-file-comments.element.js';

/** A centered note filling the space a diff would take. */
export const diffPlaceholderStyles = css`
    .placeholder {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 12px;
        flex-grow: 1;
        padding: 24px;
        text-align: center;
        color: ${viraThemeByKeys.grey.foreground['non-body'].foreground.value};
    }
`;

/**
 * The diff pane's view of a file with no line diff: an image shown before and after, or a note for
 * a binary or oversized file. Its whole-file comments ({@link VirFileComments}) sit on top, and
 * their events bubble out of this element.
 */
export const VirDiffWholeFile = defineAppElement<{
    path: string;
    /** Only an image, binary, or oversized file belongs here. */
    content: GitDiffFileContents;
    enableComments: boolean;
    /** This file's whole-file comments only. */
    comments: ReadonlyArray<ReviewComment>;
}>()({
    tagName: 'vir-diff-whole-file',
    events: {
        /** The user chose to wait for an oversized file's diff after all. */
        showAnyway: defineElementEvent<undefined>(),
    },
    styles: css`
        :host {
            display: flex;
            flex-direction: column;
            flex-grow: 1;
            min-width: 0;
            min-height: 0;
        }

        ${imageDiffStyles}
        ${diffPlaceholderStyles}
    `,
    render({inputs, dispatch, events}) {
        const commentsTemplate = inputs.enableComments
            ? html`
                  <${VirFileComments.assign({
                      path: inputs.path,
                      comments: inputs.comments,
                  })}></${VirFileComments}>
              `
            : nothing;

        if (!inputs.content.tooLargeOrBinary) {
            return html`
                ${commentsTemplate}
                ${renderImageDiff({
                    content: inputs.content,
                })}
            `;
        }

        return html`
            ${commentsTemplate}
            <div class="placeholder">
                ${inputs.content.canShowAnyway
                    ? `Over ${maxDiffFileLines} lines — diffing it can lock the page up for a while.`
                    : 'Binary or oversized file — no diff shown.'}
                ${inputs.content.canShowAnyway
                    ? html`
                          <${ViraButton.assign({
                              text: 'Show diff anyway',
                              buttonSize: ViraSize.Small,
                              color: ViraColorVariant.Neutral,
                          })}
                              ${listen('click', () => {
                                  dispatch(
                                      new events.showAnyway({
                                          detail: undefined,
                                      }),
                                  );
                              })}
                          ></${ViraButton}>
                      `
                    : nothing}
            </div>
        `;
    },
});
