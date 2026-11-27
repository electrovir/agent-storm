import {ViewerFileStatus, ViewerFileType} from '@agent-storm/common';
import {defineAppElement} from '@agent-storm/core/frontend';
import {check} from '@augment-vir/assert';
import {extractErrorMessage} from '@augment-vir/common';
import {convertDuration} from 'date-vir';
import {css, defineElementEvent, html, listen, nothing, type HtmlInterpolation} from 'element-vir';
import {ViraButton, ViraInput, ViraSize, viraThemeByKeys} from 'vira';
import {loadViewerFile, viewerStatusMessages, type ViewerFile} from '../../util/viewer-load.js';

/**
 * Both frames lack `allow-same-origin`, which gives them an opaque origin: nothing inside can read
 * the app's storage, send its bearer token, or call its API. An HTML file may run scripts, since AI
 * written pages are often interactive. A Markdown file's document never needs them.
 */
const frameSandboxes: Readonly<Record<ViewerFileType.Html | ViewerFileType.Markdown, string>> = {
    [ViewerFileType.Html]: 'allow-scripts',
    [ViewerFileType.Markdown]: 'allow-popups allow-popups-to-escape-sandbox',
};

const fileRenderers: Readonly<Record<ViewerFileType, (file: ViewerFile) => HtmlInterpolation>> = {
    [ViewerFileType.Html](file) {
        return html`
            <iframe
                class="frame"
                aria-label=${file.resolvedPath}
                sandbox=${frameSandboxes[ViewerFileType.Html]}
                srcdoc=${file.srcdoc}
            ></iframe>
        `;
    },
    [ViewerFileType.Markdown](file) {
        return html`
            <iframe
                class="frame"
                aria-label=${file.resolvedPath}
                sandbox=${frameSandboxes[ViewerFileType.Markdown]}
                srcdoc=${file.srcdoc}
            ></iframe>
        `;
    },
    [ViewerFileType.Image](file) {
        return html`
            <div class="image-frame">
                <img src=${file.imageUrl} alt=${file.resolvedPath} />
            </div>
        `;
    },
};

function revokeImage(file: ViewerFile | undefined) {
    if (file?.imageUrl) {
        URL.revokeObjectURL(file.imageUrl);
    }
}

/**
 * Shows one file, picked by typing its path. While shown, the file is polled for changes, so a page
 * an AI rewrites updates in place.
 */
export const VirPaneViewer = defineAppElement<{
    folder: string;
    path: string;
    isShown: boolean;
}>()({
    tagName: 'vir-pane-viewer',
    events: {
        pathChange: defineElementEvent<string>(),
    },
    state() {
        return {
            /** The path `file` and `problem` belong to. */
            loadedPath: undefined as string | undefined,
            file: undefined as ViewerFile | undefined,
            problem: undefined as string | undefined,
            draftPath: '',
            pollHandle: undefined as ReturnType<typeof setInterval> | undefined,
        };
    },
    init({updateState, host}) {
        updateState({
            pollHandle: setInterval(
                async () => {
                    if (
                        !host.instanceInputs.isShown ||
                        !host.instanceInputs.path ||
                        document.hidden ||
                        !host.checkVisibility()
                    ) {
                        return;
                    }
                    await refresh({
                        host,
                        updateState,
                        isForced: false,
                    });
                },
                convertDuration(
                    {
                        seconds: 2,
                    },
                    {
                        milliseconds: true,
                    },
                ).milliseconds,
            ),
        });
    },
    cleanup({state}) {
        clearInterval(state.pollHandle);
        revokeImage(state.file);
    },
    styles: css`
        :host {
            display: contents;
        }

        .viewer {
            position: absolute;
            inset: 0;
            display: flex;
            flex-direction: column;
            overflow: hidden;
        }

        .toolbar {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 6px 8px;
            border-bottom: 1px solid
                ${viraThemeByKeys.grey['behind-bg'].decoration.background.value};

            & .path {
                flex-grow: 1;
                min-width: 0;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
                font-size: 12px;
                color: ${viraThemeByKeys.grey.foreground['non-body'].foreground.value};
            }
        }

        .frame {
            flex-grow: 1;
            border: none;
            background: white;
        }

        .image-frame {
            display: flex;
            flex-grow: 1;
            align-items: center;
            justify-content: center;
            min-height: 0;
            padding: 12px;
            overflow: auto;

            & img {
                max-width: 100%;
                max-height: 100%;
                object-fit: contain;
            }
        }

        .message,
        .empty {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            flex-grow: 1;
            gap: 12px;
            padding: 16px;
            font-size: 13px;
            text-align: center;
        }

        .empty .picker {
            display: flex;
            gap: 8px;
            width: 100%;
            max-width: 480px;

            & ${ViraInput} {
                flex-grow: 1;
                min-width: 0;
            }
        }
    `,
    render({inputs, state, updateState, dispatch, events, host}) {
        if (inputs.path !== state.loadedPath) {
            revokeImage(state.file);
            updateState({
                loadedPath: inputs.path,
                file: undefined,
                problem: undefined,
            });
            if (inputs.path) {
                void refresh({
                    host,
                    updateState,
                    isForced: true,
                });
            }
        }

        function openDraftPath() {
            const path = state.draftPath.trim();
            if (path) {
                dispatch(
                    new events.pathChange({
                        detail: path,
                    }),
                );
            }
        }

        if (!inputs.path) {
            return html`
                <div class="viewer">
                    <div class="empty">
                        <span>
                            Enter the path of an HTML, Markdown, or image file. A relative path is
                            relative to this folder.
                        </span>
                        <div class="picker">
                            <${ViraInput.assign({
                                value: state.draftPath,
                                placeholder: 'notes.md',
                            })}
                                ${listen(ViraInput.events.valueChange, (event) => {
                                    updateState({
                                        draftPath: event.detail,
                                    });
                                })}
                                ${listen('keydown', (event) => {
                                    if (
                                        check.instanceOf(event, KeyboardEvent) &&
                                        event.key === 'Enter'
                                    ) {
                                        openDraftPath();
                                    }
                                })}
                            ></${ViraInput}>
                            <${ViraButton.assign({
                                text: 'Open',
                                buttonSize: ViraSize.Small,
                                isDisabled: !state.draftPath.trim(),
                            })}
                                ${listen('click', () => {
                                    openDraftPath();
                                })}
                            ></${ViraButton}>
                        </div>
                    </div>
                </div>
            `;
        }

        return html`
            <div class="viewer">
                <div class="toolbar">
                    <span class="path">${state.file?.resolvedPath || inputs.path}</span>
                    <${ViraButton.assign({
                        text: 'Reload',
                        buttonSize: ViraSize.Small,
                    })}
                        ${listen('click', async () => {
                            await refresh({
                                host,
                                updateState,
                                isForced: true,
                            });
                        })}
                    ></${ViraButton}>
                    <${ViraButton.assign({
                        text: 'Change',
                        buttonSize: ViraSize.Small,
                    })}
                        ${listen('click', () => {
                            updateState({
                                draftPath: inputs.path,
                            });
                            dispatch(
                                new events.pathChange({
                                    detail: '',
                                }),
                            );
                        })}
                    ></${ViraButton}>
                </div>
                ${state.problem
                    ? html`
                          <div class="message">${state.problem}</div>
                      `
                    : state.file
                      ? fileRenderers[state.file.fileType](state.file)
                      : nothing}
            </div>
        `;
    },
});

/**
 * Loads the tab's current file into the element's state. A forced load skips the unchanged check.
 * An answer for a path the tab has since left is dropped.
 */
async function refresh({
    host,
    updateState,
    isForced,
}: Readonly<{
    host: InstanceType<typeof VirPaneViewer>;
    updateState: (newState: Partial<InstanceType<typeof VirPaneViewer>['instanceState']>) => void;
    isForced: boolean;
}>) {
    const {folder, path} = host.instanceInputs;
    const knownFile = host.instanceState.file;
    const result = await loadViewerFile({
        folder,
        path,
        knownModifiedAtMs: isForced || !knownFile ? 0 : knownFile.modifiedAtMs,
    }).catch((error: unknown) => {
        return extractErrorMessage(error);
    });

    if (host.instanceInputs.path !== path) {
        if (!check.isString(result)) {
            revokeImage(result.file);
        }
    } else if (check.isString(result)) {
        updateState({
            problem: result,
        });
    } else if (result.status !== ViewerFileStatus.Unchanged) {
        revokeImage(host.instanceState.file);
        updateState({
            file: result.file,
            problem: viewerStatusMessages[result.status],
        });
    }
}
