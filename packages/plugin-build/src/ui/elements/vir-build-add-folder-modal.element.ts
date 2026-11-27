import {addRepoEndpoint, checkPathEndpoint, createPathEndpoint} from '@agent-storm/common';
import {defineAppElement, fetchApi} from '@agent-storm/core/frontend';
import {extractErrorMessage} from '@augment-vir/common';
import {HttpMethod} from '@rest-vir/api';
import {css, defineElementEvent, html, listen} from 'element-vir';
import {ViraButton, ViraColorVariant, ViraEmphasis, ViraInput, ViraModal} from 'vira';

/** The Build sidebar's "Add folder" modal. Its form resets every time it closes. */
export const VirBuildAddFolderModal = defineAppElement<{
    open: boolean;
}>()({
    tagName: 'vir-build-add-folder-modal',
    events: {
        close: defineElementEvent<void>(),
        /** A failure to show in the sidebar's error banner. */
        errorReport: defineElementEvent<string>(),
        /** The added folder's absolute path, sent after the modal closes. */
        folderAdd: defineElementEvent<string>(),
    },
    state() {
        return {
            folderPath: '',
            isSubmitting: false,
        };
    },
    styles: css`
        .body {
            display: flex;
            flex-direction: column;
            gap: 12px;
            width: min(520px, calc(100dvw - 48px));
            max-width: 100%;
            box-sizing: border-box;

            & ${ViraInput} {
                min-width: 0;
                width: 100%;
            }
        }

        .footer {
            display: flex;
            justify-content: flex-end;
            gap: 8px;
        }

        @media (max-width: 420px) {
            .body {
                width: calc(100dvw - 32px);
            }

            .footer {
                justify-content: stretch;

                & ${ViraButton} {
                    width: 100%;
                }
            }
        }
    `,
    render({inputs, state, updateState, dispatch, events}) {
        function close() {
            updateState({
                folderPath: '',
                isSubmitting: false,
            });
            dispatch(
                new events.close({
                    detail: undefined,
                }),
            );
        }

        async function submit() {
            const input = state.folderPath.trim();
            if (!input || state.isSubmitting) {
                return;
            }
            try {
                updateState({
                    isSubmitting: true,
                });
                /**
                 * The server resolves `~` and relative paths. A missing path needs confirmation so
                 * a typo doesn't silently create directories.
                 */
                const checked = await fetchApi(checkPathEndpoint, HttpMethod.Post, {
                    requestData: {
                        path: input,
                    },
                });
                if (!checked.exists) {
                    if (
                        !globalThis.confirm(
                            `Path does not exist:\n\n${checked.resolvedPath}\n\nCreate it?`,
                        )
                    ) {
                        updateState({
                            isSubmitting: false,
                        });
                        return;
                    }
                    await fetchApi(createPathEndpoint, HttpMethod.Post, {
                        requestData: {
                            path: checked.resolvedPath,
                        },
                    });
                }
                /** Re-adding a saved folder brings it back into the hide-inactive filter. */
                await fetchApi(addRepoEndpoint, HttpMethod.Post, {
                    requestData: {
                        path: checked.resolvedPath,
                    },
                });
                close();
                dispatch(
                    new events.folderAdd({
                        detail: checked.resolvedPath,
                    }),
                );
            } catch (error: unknown) {
                updateState({
                    isSubmitting: false,
                });
                dispatch(
                    new events.errorReport({
                        detail: extractErrorMessage(error),
                    }),
                );
            }
        }

        return html`
            <${ViraModal.assign({
                open: inputs.open,
                modalTitle: 'Add folder',
            })}
                ${listen(ViraModal.events.modalClose, close)}
            >
                <div class="body">
                    <${ViraInput.assign({
                        label: 'Folder path',
                        value: state.folderPath,
                        placeholder: '~/src/project',
                        showClearButton: true,
                        disableBrowserHelps: true,
                        disabled: state.isSubmitting,
                    })}
                        ${listen(ViraInput.events.valueChange, (event) => {
                            updateState({
                                folderPath: event.detail,
                            });
                        })}
                        ${listen('keydown', async (event) => {
                            if (event instanceof KeyboardEvent && event.key === 'Enter') {
                                await submit();
                            }
                        })}
                    ></${ViraInput}>
                    <div class="footer">
                        <${ViraButton.assign({
                            text: 'Cancel',
                            buttonEmphasis: ViraEmphasis.Subtle,
                            color: ViraColorVariant.Neutral,
                            isDisabled: state.isSubmitting,
                        })}
                            ${listen('click', () => {
                                if (!state.isSubmitting) {
                                    close();
                                }
                            })}
                        ></${ViraButton}>
                        <${ViraButton.assign({
                            text: 'Add',
                            color: ViraColorVariant.Brand,
                            isDisabled: !state.folderPath.trim() || state.isSubmitting,
                        })}
                            ${listen('click', async () => {
                                if (state.folderPath.trim() && !state.isSubmitting) {
                                    await submit();
                                }
                            })}
                        ></${ViraButton}>
                    </div>
                </div>
            </${ViraModal}>
        `;
    },
});
