import {defineAppElement} from '@agent-storm/core/frontend';
import {toDisplayedOldContent, type DiffCodeViewParams} from '@agent-storm/plugin-diff';
import {FileDiff} from '@pierre/diffs';
import {css, defineElementEvent, html, onDomCreated} from 'element-vir';

/**
 * The Diff V2 pane's single-file diff, drawn by `@pierre/diffs`. Stays mounted for the pane's whole
 * life, like the Diff pane's own view, so a poll that changes nothing keeps the scroll position.
 */
export const VirPierreDiffView = defineAppElement<
    Omit<DiffCodeViewParams, 'isHidden' | 'setChunkCount'>
>()({
    tagName: 'vir-pierre-diff-view',
    events: {
        /** The diff was redrawn for a different file or different content, with this many chunks. */
        chunkCountChange: defineElementEvent<number>(),
    },
    state() {
        return {
            container: undefined as HTMLElement | undefined,
            fileDiff: undefined as FileDiff | undefined,
            /** What the mounted diff shows, so an unchanged poll doesn't redraw it. */
            renderedKey: undefined as string | undefined,
            /** The `chunkScroll` request already scrolled to. */
            handledChunkScroll: undefined as number | undefined,
        };
    },
    styles: css`
        :host([data-hidden]) {
            display: none;
        }

        :host {
            display: flex;
            flex-grow: 1;
            min-width: 0;
            min-height: 0;
        }

        .diff-host {
            flex-grow: 1;
            min-width: 0;
            min-height: 0;
            overflow: auto;
        }
    `,
    cleanup({state}) {
        state.fileDiff?.cleanUp();
    },
    render({inputs, state, updateState, dispatch, events}) {
        const content = inputs.content;
        const path = inputs.path;
        const isTextDiff = !!content && !content.tooLargeOrBinary && !content.isImage;

        if (state.container && content && isTextDiff && inputs.fileKey && path) {
            const oldContent = toDisplayedOldContent({
                content,
                hideWhitespace: inputs.hideWhitespace,
            });
            const options = {
                themeType: inputs.isDark ? 'dark' : 'light',
                diffStyle: inputs.unified ? 'unified' : 'split',
                overflow: inputs.softWrap ? 'wrap' : 'scroll',
                expandUnchanged: !inputs.collapseUnchanged,
                disableFileHeader: true,
            } as const;
            const renderedKey = JSON.stringify([
                inputs.fileKey,
                options,
                oldContent,
                content.newContent,
            ]);
            if (renderedKey !== state.renderedKey) {
                const fileDiff = state.fileDiff || new FileDiff(options);
                fileDiff.setOptions(options);
                fileDiff.render({
                    oldFile: {
                        name: path,
                        contents: oldContent,
                    },
                    newFile: {
                        name: path,
                        contents: content.newContent,
                    },
                    containerWrapper: state.container,
                    forceRender: true,
                });
                updateState({
                    fileDiff,
                    renderedKey,
                });
                dispatch(
                    new events.chunkCountChange({
                        detail: fileDiff.fileDiff?.hunks.length ?? 0,
                    }),
                );
            }
        }

        if (inputs.chunkScroll && inputs.chunkScroll.requestId !== state.handledChunkScroll) {
            updateState({
                handledChunkScroll: inputs.chunkScroll.requestId,
            });
            const hunk = state.fileDiff?.fileDiff?.hunks[inputs.chunkScroll.chunkIndex];
            const root = state.container?.querySelector('diffs-container')?.shadowRoot;
            const row = hunk
                ? root?.querySelector(
                      `[data-additions] [data-line="${hunk.additionStart}"], [data-unified] [data-line="${hunk.additionStart}"]`,
                  )
                : undefined;
            row?.scrollIntoView({
                block: 'start',
            });
        }

        return html`
            <div
                class="diff-host"
                ${onDomCreated((element) => {
                    if (element instanceof HTMLElement && !state.container) {
                        updateState({
                            container: element,
                        });
                    }
                })}
            ></div>
        `;
    },
});
