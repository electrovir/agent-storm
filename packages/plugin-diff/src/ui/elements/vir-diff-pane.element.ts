// cspell:words meslo menlo

import {DiffLayout, settingsEndpoint, type DiffSelection} from '@agent-storm/common';
import {
    ScreenSize,
    defineAppElement,
    fetchApi,
    listenToDarkMode,
    spinAnimationCss,
    spinKeyframesCss,
} from '@agent-storm/core/frontend';
import {extractErrorMessage} from '@augment-vir/common';
import {HttpMethod} from '@rest-vir/api';
import {
    asyncProp,
    css,
    defineElementEvent,
    html,
    listen,
    nothing,
    type HtmlInterpolation,
} from 'element-vir';
import {LucideLoaderIcon, ViraIcon, createSizedIcon, viraThemeByKeys} from 'vira';
import {
    allSelectValues,
    findSelected,
    statusFilesKeys,
    toSelectValue,
} from '../../util/diff-status.js';
import {createDiffPaneComments} from './diff-pane-comments.js';
import {createDiffPaneController, createDiffPaneState} from './diff-pane-controller.js';
import {stageSide, writeDiffSettings} from './diff-pane-requests.js';
import {VirDiffCodeView} from './vir-diff-code-view.element.js';
import {VirDiffCommentComposer} from './vir-diff-comment-composer.element.js';
import {VirDiffFileList} from './vir-diff-file-list.element.js';
import {VirDiffFileMenu} from './vir-diff-file-menu.element.js';
import {VirDiffFileSection} from './vir-diff-file-section.element.js';
import {VirDiffHunkMenu} from './vir-diff-hunk-menu.element.js';
import {VirDiffReviewFile} from './vir-diff-review-file.element.js';
import {VirDiffReview} from './vir-diff-review.element.js';
import {VirDiffToolbar, type DiffSettings} from './vir-diff-toolbar.element.js';
import {VirDiffWholeFile, diffPlaceholderStyles} from './vir-diff-whole-file.element.js';
import {VirFileComments} from './vir-file-comments.element.js';

const loaderIcon = createSizedIcon(LucideLoaderIcon, 24);

export const VirDiffPane = defineAppElement<{
    folder: string;
    /**
     * True when the Diff tab is the visible one. Drives the refresh loop: a hidden pane holds no
     * timer, so background folders cost nothing.
     */
    active: boolean;
    screenSize: ScreenSize;
    /** Shown above the desktop file list. */
    sidebarHeader?: HtmlInterpolation | undefined;
    /** Shown at the end of the toolbar. */
    toolbarTrailing?: HtmlInterpolation | undefined;
    /**
     * Show and take review comments. Only a manual review's checkout has a review for them to post
     * with; anywhere else they would be written to a review that never gets submitted.
     */
    enableComments?: boolean | undefined;
    /** What this list's tab last had open, which wins over the folder's last value. */
    savedSelection?: Readonly<DiffSelection> | undefined;
}>()({
    tagName: 'vir-diff-pane',
    events: {
        /** The open file or the stacked review side changed, with only the changed value set. */
        selectionChange: defineElementEvent<DiffSelection>(),
    },
    state() {
        return {
            ...createDiffPaneState(),
            /**
             * Toolbar choices from the user's settings, so they survive a reload and follow the
             * user across browsers. A `DiffLayout.Auto` layout follows the screen size. The toggles
             * patch this in the same step as writing the settings, rather than waiting on a
             * re-read, so the buttons respond immediately.
             */
            diffSettings: asyncProp({
                async updateCallback(): Promise<DiffSettings> {
                    const settings = await fetchApi(settingsEndpoint, HttpMethod.Get);
                    return {
                        diffLayout: settings.diffLayout || DiffLayout.Auto,
                        /**
                         * A settings file written before this field existed reads as undefined, not
                         * `false`.
                         */
                        hideWhitespace: settings.diffHideWhitespace ?? true,
                        collapseUnchanged: settings.diffCollapseUnchanged ?? true,
                    };
                },
            }),
        };
    },
    styles: css`
        :host {
            display: flex;
            flex-direction: column;
            width: 100%;
            height: 100%;
            min-height: 0;
            font-size: 13px;
        }

        /*
         * The open file's full path, which nothing else in the pane shows any more — the file list
         * rows and the mobile trigger are both down to the base name.
         */
        .selected-path {
            flex-grow: 0;
            flex-shrink: 0;
            padding: 4px 8px;
            overflow: hidden;
            white-space: nowrap;
            text-overflow: ellipsis;
            border-bottom: 1px solid
                ${viraThemeByKeys.grey['behind-bg'].decoration.background.value};
            font-family: 'MesloLGS NF', Menlo, monospace;
            font-size: 11px;
            color: ${viraThemeByKeys.grey.foreground['non-body'].foreground.value};
        }

        .body {
            position: relative;
            display: flex;
            flex-direction: row;
            flex-grow: 1;
            min-height: 0;
            min-width: 0;
        }

        ${VirDiffCodeView}[data-hidden] {
            display: none;
        }

        /*
         * Covers the outgoing diff while the next one loads, instead of unmounting the editor and
         * letting the pane collapse to nothing. The editor underneath keeps its width, so the file
         * list and the toolbar don't jump every time a different file is picked.
         */
        .loading-overlay {
            position: absolute;
            inset: 0;
            display: flex;
            align-items: center;
            justify-content: center;
            background: ${viraThemeByKeys.grey['behind-bg'].invisible.background.value};
            opacity: 0.75;
            pointer-events: none;

            & ${ViraIcon} {
                ${spinAnimationCss}
            }
        }

        ${spinKeyframesCss}

        ${diffPlaceholderStyles}

        .error {
            color: ${viraThemeByKeys.red.foreground.body.foreground.value};
        }
    `,
    init({updateState}) {
        updateState({
            stopThemeListener: listenToDarkMode((isDark) => {
                updateState({
                    isDark,
                });
            }),
        });
    },
    cleanup({state}) {
        state.stopThemeListener?.();
        if (state.refreshTimer) {
            clearInterval(state.refreshTimer);
        }
    },
    render({inputs, state, updateState, dispatch, events}) {
        const isMobile = inputs.screenSize === ScreenSize.Mobile;
        state.diffSettings.update();
        /** Until the settings read lands, and if it fails, the toolbar shows these. */
        const diffSettings: DiffSettings = state.diffSettings.isResolved()
            ? state.diffSettings.value
            : {
                  diffLayout: DiffLayout.Auto,
                  hideWhitespace: true,
                  collapseUnchanged: true,
              };
        const unifiedByLayout: Readonly<Record<DiffLayout, boolean>> = {
            [DiffLayout.Auto]: isMobile,
            [DiffLayout.Split]: false,
            [DiffLayout.Inline]: true,
        };
        const unified = unifiedByLayout[diffSettings.diffLayout];
        const selected = findSelected(state.status, state.selectedValue);

        /**
         * Writes the settings so the choice sticks across reloads, and updates the local copy
         * without waiting on the round trip so the toolbar responds immediately.
         */
        async function saveDiffSettings(nextSettings: Readonly<Partial<DiffSettings>>) {
            const settings = {
                ...diffSettings,
                ...nextSettings,
            };
            state.diffSettings.setValue(settings);
            try {
                await writeDiffSettings(settings);
            } catch (error) {
                updateState({
                    statusError: extractErrorMessage(error),
                });
            }
        }

        const controller = createDiffPaneController({
            inputs,
            state,
            updateState,
            saveSelection(selection) {
                dispatch(
                    new events.selectionChange({
                        detail: selection,
                    }),
                );
            },
        });
        controller.syncRefreshTimer();
        const comments = createDiffPaneComments({
            inputs,
            state,
            updateState,
        });

        const content = state.diffContent;
        const selectedPath = selected?.file.path;
        const hasFiles = allSelectValues(state.status).length > 0;

        const toolbarTemplate = html`
            <${VirDiffToolbar.assign({
                isMobile,
                status: state.status,
                selectedValue: state.selectedValue,
                reviewSide: state.reviewSide,
                hasChunks: state.chunkCount > 0,
                unified,
                diffSettings,
                trailing: inputs.toolbarTrailing,
            })}
                ${listen(VirDiffToolbar.events.fileStep, async (event) => {
                    await controller.stepFile(event.detail);
                })}
                ${listen(VirDiffToolbar.events.chunkStep, (event) => {
                    controller.stepChunk(event.detail);
                })}
                ${listen(VirDiffToolbar.events.settingsChange, async (event) => {
                    await saveDiffSettings(event.detail);
                })}
                ${listen(VirDiffToolbar.events.selectedFileStage, async () => {
                    await controller.onStageSelectedFile();
                })}
                ${listen(VirDiffFileMenu.events.fileSelect, async (event) => {
                    await controller.selectFile(event.detail);
                })}
                ${listen(VirDiffFileMenu.events.reviewToggle, (event) => {
                    controller.toggleReview(event.detail);
                })}
            ></${VirDiffToolbar}>
        `;

        const reviewTemplate = state.reviewSide
            ? html`
                  <${VirDiffReview.assign({
                      enableComments: !!inputs.enableComments,
                      folder: inputs.folder,
                      side: state.reviewSide,
                      files: state.status?.[statusFilesKeys[state.reviewSide]] ?? [],
                      hideWhitespace: diffSettings.hideWhitespace,
                      unified,
                      collapseUnchanged: diffSettings.collapseUnchanged,
                      isDark: state.isDark,
                      isMobile,
                      reviewComments: state.reviewComments,
                      commentDraft: state.commentDraft,
                  })}
                      ${listen(VirDiffReviewFile.events.addCommentRequested, (event) => {
                          comments.openCommentDraft(event.detail);
                      })}
                      ${listen(VirDiffReviewFile.events.editCommentRequested, (event) => {
                          comments.openEditCommentDraft(event.detail);
                      })}
                      ${listen(VirDiffReviewFile.events.deleteCommentRequested, async (event) => {
                          await comments.onDeleteComment(event.detail);
                      })}
                      ${listen(VirDiffReviewFile.events.fileSelected, async (event) => {
                          if (state.reviewSide) {
                              await controller.selectFile(
                                  toSelectValue(state.reviewSide, event.detail),
                              );
                          }
                      })}
                      ${listen(VirDiffReviewFile.events.chunkMenuRequested, (event) => {
                          if (state.busy || !state.reviewSide) {
                              return;
                          }
                          updateState({
                              hunkMenu: {
                                  ...event.detail,
                                  target: {
                                      side: state.reviewSide,
                                      file: event.detail.file,
                                  },
                              },
                          });
                      })}
                      ${listen(VirDiffReviewFile.events.stageFile, async (event) => {
                          if (state.reviewSide) {
                              await controller.onStageWholeFiles([
                                  {
                                      side: state.reviewSide,
                                      file: event.detail,
                                  },
                              ]);
                          }
                      })}
                  ></${VirDiffReview}>
              `
            : nothing;

        const wholeFileTemplate =
            selected && content && (content.tooLargeOrBinary || content.isImage)
                ? html`
                      <${VirDiffWholeFile.assign({
                          path: selected.file.path,
                          content,
                          enableComments: !!inputs.enableComments,
                          comments: state.reviewComments.filter((comment) => {
                              return comment.path === selected.file.path && !comment.line;
                          }),
                      })}
                          ${listen(VirDiffWholeFile.events.showAnyway, async () => {
                              await controller.showLargeDiffAnyway();
                          })}
                          ${listen(VirFileComments.events.addCommentRequested, (event) => {
                              comments.openCommentDraft(event.detail);
                          })}
                          ${listen(VirFileComments.events.editCommentRequested, (event) => {
                              comments.openEditCommentDraft(event.detail);
                          })}
                          ${listen(VirFileComments.events.deleteCommentRequested, async (event) => {
                              await comments.onDeleteComment(event.detail);
                          })}
                      ></${VirDiffWholeFile}>
                  `
                : nothing;

        const mainTemplate = state.reviewSide
            ? reviewTemplate
            : state.statusError || state.diffError
              ? html`
                    <div class="placeholder error">${state.statusError || state.diffError}</div>
                `
              : hasFiles
                ? selected
                    ? wholeFileTemplate
                    : html`
                          <div class="placeholder">Select a file to see its diff.</div>
                      `
                : html`
                      <div class="placeholder">No changes in this folder.</div>
                  `;

        const codeViewTemplate = html`
            <${VirDiffCodeView.assign({
                fileKey: state.selectedValue,
                path: selectedPath,
                content,
                hideWhitespace: diffSettings.hideWhitespace,
                unified,
                collapseUnchanged: diffSettings.collapseUnchanged,
                isDark: state.isDark,
                isMobile,
                enableComments: !!inputs.enableComments,
                comments: state.reviewComments.filter((comment) => {
                    return comment.path === selectedPath;
                }),
                commentingLine:
                    state.commentDraft?.path === selectedPath
                        ? state.commentDraft?.line
                        : undefined,
                canStage: !state.busy && !!selected,
                chunkScroll: state.chunkScroll,
            })}
                ?data-hidden=${!!state.reviewSide ||
                !selected ||
                content?.tooLargeOrBinary ||
                content?.isImage}
                ${listen(VirDiffCodeView.events.addCommentRequested, (event) => {
                    comments.openCommentDraft(event.detail);
                })}
                ${listen(VirDiffCodeView.events.editCommentRequested, (event) => {
                    comments.openEditCommentDraft(event.detail);
                })}
                ${listen(VirDiffCodeView.events.deleteCommentRequested, async (event) => {
                    await comments.onDeleteComment(event.detail);
                })}
                ${listen(VirDiffCodeView.events.hunkMenuRequested, (event) => {
                    const target = findSelected(state.status, state.selectedValue);
                    if (target) {
                        updateState({
                            hunkMenu: {
                                ...event.detail,
                                target,
                            },
                        });
                    }
                })}
                ${listen(VirDiffCodeView.events.chunkCountChange, (event) => {
                    updateState({
                        chunkCount: event.detail,
                    });
                })}
                ${listen(VirDiffCodeView.events.chunkActivate, (event) => {
                    updateState({
                        activeChunkIndex: event.detail,
                    });
                })}
            ></${VirDiffCodeView}>
        `;

        const hunkMenuTemplate = state.hunkMenu
            ? html`
                  <${VirDiffHunkMenu.assign({
                      menu: state.hunkMenu,
                  })}
                      ${listen(VirDiffHunkMenu.events.close, controller.closeHunkMenu)}
                      ${listen(VirDiffHunkMenu.events.stage, async (event) => {
                          controller.closeHunkMenu();
                          await controller.onStageChunks(event.detail);
                      })}
                      ${listen(VirDiffHunkMenu.events.undo, async (event) => {
                          controller.closeHunkMenu();
                          await controller.onUndoChunks(event.detail);
                      })}
                  ></${VirDiffHunkMenu}>
              `
            : nothing;

        const commentComposerTemplate = state.commentDraft
            ? html`
                  <${VirDiffCommentComposer.assign({
                      draft: state.commentDraft,
                  })}
                      ${listen(VirDiffCommentComposer.events.bodyChange, (event) => {
                          comments.setCommentBody(event.detail);
                      })}
                      ${listen(VirDiffCommentComposer.events.cancel, comments.closeCommentDraft)}
                      ${listen(VirDiffCommentComposer.events.save, async () => {
                          await comments.saveCommentDraft();
                      })}
                  ></${VirDiffCommentComposer}>
              `
            : nothing;

        const collapsedSides = {
            ...state.collapsedSides,
            ...inputs.savedSelection?.collapsedSides,
        };
        const fileListTemplate =
            isMobile || !hasFiles
                ? nothing
                : html`
                      <${VirDiffFileList.assign({
                          status: state.status,
                          selectedValue: state.selectedValue,
                          markedValues: state.markedValues,
                          reviewSide: state.reviewSide,
                          isBusy: state.busy,
                          collapsedSides,
                          header: inputs.sidebarHeader,
                      })}
                          ${listen(VirDiffFileSection.events.rowClick, async (event) => {
                              await controller.onRowClick(event.detail);
                          })}
                          ${listen(VirDiffFileSection.events.filesStage, async (event) => {
                              await controller.onStageWholeFiles(event.detail);
                          })}
                          ${listen(VirDiffFileSection.events.filesDiscard, async (event) => {
                              await controller.onDiscardFiles(event.detail);
                          })}
                          ${listen(VirDiffFileSection.events.sideStage, async (event) => {
                              const side = event.detail;
                              await controller.runIndexWrite(async () => {
                                  await stageSide({
                                      folder: inputs.folder,
                                      side,
                                  });
                              });
                          })}
                          ${listen(VirDiffFileSection.events.unstagedDiscard, async () => {
                              await controller.onDiscardUnstaged();
                          })}
                          ${listen(VirDiffFileSection.events.reviewToggle, (event) => {
                              controller.toggleReview(event.detail);
                          })}
                          ${listen(VirDiffFileSection.events.collapseChange, (event) => {
                              const changedSides = {
                                  ...collapsedSides,
                                  [event.detail.side]: event.detail.isCollapsed,
                              };
                              updateState({
                                  collapsedSides: changedSides,
                              });
                              dispatch(
                                  new events.selectionChange({
                                      detail: {
                                          collapsedSides: changedSides,
                                      },
                                  }),
                              );
                          })}
                      ></${VirDiffFileList}>
                  `;

        return html`
            ${toolbarTemplate}
            ${selected && !state.reviewSide
                ? html`
                      <div class="selected-path" title=${selected.file.path}>
                          ${selected.file.path}
                      </div>
                  `
                : nothing}
            <div class="body">
                ${mainTemplate} ${codeViewTemplate} ${hunkMenuTemplate} ${commentComposerTemplate}
                ${selected && !content && !state.diffError && !state.reviewSide
                    ? html`
                          <div class="loading-overlay">
                              <${ViraIcon.assign({
                                  icon: loaderIcon,
                              })}></${ViraIcon}>
                          </div>
                      `
                    : nothing}
                ${fileListTemplate}
            </div>
        `;
    },
});
