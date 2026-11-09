import {
    type AiDefinition,
    createWorktreeEndpoint,
    type FolderInfo,
    foldersEndpoint,
} from '@agent-storm/common';
import {defineAppElement, fetchApi} from '@agent-storm/core/frontend';
import {extractErrorMessage} from '@augment-vir/common';
import {HttpMethod} from '@rest-vir/api';
import {defineElementEvent, html, listen} from 'element-vir';
import {ViraButton, ViraColorVariant, ViraDropdown, ViraEmphasis, ViraInput, ViraModal} from 'vira';
import {savingIcon} from '../icons/saving-icon.js';
import {aiSelectOptions} from './sidebar-actions.js';
import {sidebarFormModalStyles} from './sidebar-modal-styles.js';
import {defaultAiSelectValue} from './sidebar-state.js';

/** The sidebar's "New worktree" modal. Its form resets every time it closes. */
export const VirSidebarAddWorktreeModal = defineAppElement<{
    /** The repo the worktree is created under. The modal is open while this is set. */
    repoPath: string | undefined;
    aiDefinitions: ReadonlyArray<Readonly<AiDefinition>>;
    defaultAiId: string;
    /**
     * The repo root's resolved AI, which the new worktree inherits when the user leaves the select
     * on "Default". `FolderInfo.aiId` already walked the override chain on the backend, so there's
     * no config lookup to redo here.
     */
    inheritedAiId: string | undefined;
}>()({
    tagName: 'vir-sidebar-add-worktree-modal',
    events: {
        close: defineElementEvent<void>(),
        /** A failure to show in the sidebar's error banner. */
        errorReport: defineElementEvent<string>(),
        /** The folder list fetched right after creating the worktree. */
        foldersChange: defineElementEvent<ReadonlyArray<FolderInfo>>(),
        folderActivate: defineElementEvent<string>(),
    },
    state() {
        return {
            worktreeName: '',
            /** {@link defaultAiSelectValue} means inherit the repo's AI. */
            aiId: defaultAiSelectValue,
            isSubmitting: false,
        };
    },
    styles: sidebarFormModalStyles,
    render({inputs, state, updateState, dispatch, events}) {
        function close() {
            updateState({
                worktreeName: '',
                aiId: defaultAiSelectValue,
                isSubmitting: false,
            });
            dispatch(
                new events.close({
                    detail: undefined,
                }),
            );
        }

        async function submit() {
            const repoPath = inputs.repoPath;
            const trimmedName = state.worktreeName.trim();
            if (!repoPath || !trimmedName || state.isSubmitting) {
                return;
            }
            try {
                updateState({
                    isSubmitting: true,
                });
                await fetchApi(createWorktreeEndpoint, HttpMethod.Post, {
                    requestData: {
                        repoPath,
                        name: trimmedName,
                        aiId: state.aiId === defaultAiSelectValue ? undefined : state.aiId,
                    },
                });
                const folders = (await fetchApi(foldersEndpoint, HttpMethod.Get)).folders;
                dispatch(
                    new events.foldersChange({
                        detail: folders,
                    }),
                );
                close();
                const newWorktree = folders.find(
                    (folder) => folder.parentRepoPath === repoPath && folder.name === trimmedName,
                );
                if (newWorktree) {
                    dispatch(
                        new events.folderActivate({
                            detail: newWorktree.path,
                        }),
                    );
                }
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
                open: !!inputs.repoPath,
                modalTitle: 'New worktree',
            })}
                ${listen(ViraModal.events.modalClose, close)}
            >
                <div class="body">
                    <${ViraInput.assign({
                        label: 'Worktree name',
                        value: state.worktreeName,
                        placeholder: 'branch-name',
                        showClearButton: true,
                        disableBrowserHelps: true,
                        disabled: state.isSubmitting,
                    })}
                        ${listen(ViraInput.events.valueChange, (event) => {
                            updateState({
                                worktreeName: event.detail,
                            });
                        })}
                        ${listen('keydown', async (event) => {
                            if (event instanceof KeyboardEvent && event.key === 'Enter') {
                                await submit();
                            }
                        })}
                    ></${ViraInput}>
                    <${ViraDropdown.assign({
                        label: 'AI',
                        options: aiSelectOptions(inputs),
                        selected: [
                            state.aiId,
                        ],
                        isDisabled: state.isSubmitting,
                    })}
                        ${listen(ViraDropdown.events.selectedValuesChange, (event) => {
                            updateState({
                                aiId: event.detail[0] || defaultAiSelectValue,
                            });
                        })}
                    ></${ViraDropdown}>
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
                            text: 'Create',
                            color: ViraColorVariant.Brand,
                            rightSideIcon: state.isSubmitting ? savingIcon : undefined,
                            isDisabled: !state.worktreeName.trim() || state.isSubmitting,
                        })}
                            ${listen('click', submit)}
                        ></${ViraButton}>
                    </div>
                </div>
            </${ViraModal}>
        `;
    },
});
