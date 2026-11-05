import {
    type AiDefinition,
    checkPathEndpoint,
    configEndpoint,
    createPathEndpoint,
    type FolderInfo,
    foldersEndpoint,
    type RepoConfig,
    touchRepoEndpoint,
} from '@agent-storm/common';
import {extractErrorMessage} from '@augment-vir/common';
import {HttpMethod} from '@rest-vir/api';
import {defineElementEvent, html, listen} from 'element-vir';
import {ViraButton, ViraColorVariant, ViraDropdown, ViraEmphasis, ViraInput, ViraModal} from 'vira';
import {fetchApi} from '../../util/api-client.js';
import {defineAppElement} from '../define-app-element.js';
import {activationTargetFor, aiSelectOptions} from './sidebar-actions.js';
import {sidebarFormModalStyles} from './sidebar-modal-styles.js';
import {defaultAiSelectValue} from './sidebar-state.js';

/** The sidebar's "New repo" modal. Its form resets every time it closes. */
export const VirSidebarAddRepoModal = defineAppElement<{
    open: boolean;
    aiDefinitions: ReadonlyArray<Readonly<AiDefinition>>;
    defaultAiId: string;
}>()({
    tagName: 'vir-sidebar-add-repo-modal',
    events: {
        close: defineElementEvent<void>(),
        /** A failure to show in the sidebar's error banner. */
        errorReport: defineElementEvent<string>(),
        /** The folder list fetched right after adding a new repo. */
        foldersChange: defineElementEvent<ReadonlyArray<FolderInfo>>(),
        /** The repo list after re-adding an already configured repo bumped its activity. */
        reposChange: defineElementEvent<ReadonlyArray<RepoConfig>>(),
        folderActivate: defineElementEvent<string>(),
    },
    state() {
        return {
            repoPath: '',
            /** {@link defaultAiSelectValue} means inherit the default. */
            aiId: defaultAiSelectValue,
            isSubmitting: false,
        };
    },
    styles: sidebarFormModalStyles,
    render({inputs, state, updateState, dispatch, events}) {
        function close() {
            updateState({
                repoPath: '',
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
            const input = state.repoPath.trim();
            if (!input || state.isSubmitting) {
                return;
            }
            try {
                updateState({
                    isSubmitting: true,
                });
                /**
                 * Resolve the user's input on the server (handles `~` expansion + `path.resolve`)
                 * so we can branch on existence using a stable, absolute path. Missing paths still
                 * require explicit confirmation before creation so a typo in this modal does not
                 * create directories silently.
                 */
                const initial = await fetchApi(checkPathEndpoint, HttpMethod.Post, {
                    requestData: {
                        path: input,
                    },
                });
                const path = initial.resolvedPath;
                if (!initial.exists) {
                    if (!window.confirm(`Path does not exist:\n\n${path}\n\nCreate it?`)) {
                        updateState({
                            isSubmitting: false,
                        });
                        return;
                    }
                    await fetchApi(createPathEndpoint, HttpMethod.Post, {
                        requestData: {
                            path,
                        },
                    });
                }
                const config = await fetchApi(configEndpoint, HttpMethod.Get);
                if (config.repos.some((repo) => repo.path === path)) {
                    /**
                     * Repo already configured — don't add a duplicate. Stamp its
                     * `lastInteractedAtMs` to now (the touch endpoint resolves the owning repo and
                     * writes `Date.now()`) so the hide-inactive filter stops hiding it, then pull
                     * the refreshed config so the sidebar's `repos` mirror that filter reads
                     * reflects the new timestamp immediately instead of waiting for the next poll.
                     * Finally activate the existing entry.
                     */
                    await fetchApi(touchRepoEndpoint, HttpMethod.Post, {
                        requestData: {
                            folder: path,
                        },
                    });
                    const refreshedConfig = await fetchApi(configEndpoint, HttpMethod.Get);
                    dispatch(
                        new events.reposChange({
                            detail: refreshedConfig.repos,
                        }),
                    );
                    close();
                    dispatch(
                        new events.folderActivate({
                            detail: path,
                        }),
                    );
                    return;
                }
                const otherEntries = config.folderAiIds.filter((entry) => entry.folder !== path);
                await fetchApi(configEndpoint, HttpMethod.Put, {
                    requestData: {
                        ...config,
                        repos: [
                            ...config.repos,
                            {
                                path,
                                postWorktreeCmd: null,
                            },
                        ],
                        folderAiIds:
                            state.aiId === defaultAiSelectValue
                                ? otherEntries
                                : [
                                      ...otherEntries,
                                      {
                                          folder: path,
                                          aiId: state.aiId,
                                      },
                                  ],
                    },
                });
                /**
                 * Fetch the new folder list directly so we can find the repo's resolved path (may
                 * include a worktree-root vs. standalone-repo entry) and activate it. The backend's
                 * `PUT /config` already triggered `refreshFolderInfoNow`, so the targets are
                 * present by the time this GET returns.
                 */
                const folders = (await fetchApi(foldersEndpoint, HttpMethod.Get)).folders;
                dispatch(
                    new events.foldersChange({
                        detail: folders,
                    }),
                );
                close();
                const newFolder = folders.find((folder) => folder.path === path);
                if (newFolder) {
                    dispatch(
                        new events.folderActivate({
                            detail: activationTargetFor(newFolder, folders).path,
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
                open: inputs.open,
                modalTitle: 'New repo',
            })}
                ${listen(ViraModal.events.modalClose, close)}
            >
                <div class="body">
                    <${ViraInput.assign({
                        label: 'Repo path',
                        value: state.repoPath,
                        placeholder: '~/src/project',
                        showClearButton: true,
                        disableBrowserHelps: true,
                        disabled: state.isSubmitting,
                    })}
                        ${listen(ViraInput.events.valueChange, (event) => {
                            updateState({
                                repoPath: event.detail,
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
                            text: 'Add',
                            color: ViraColorVariant.Brand,
                            isDisabled: !state.repoPath.trim() || state.isSubmitting,
                        })}
                            ${listen('click', submit)}
                        ></${ViraButton}>
                    </div>
                </div>
            </${ViraModal}>
        `;
    },
});
