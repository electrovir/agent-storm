import {configEndpoint} from '@agent-storm/common';
import {extractErrorMessage} from '@augment-vir/common';
import {HttpMethod} from '@rest-vir/api';
import {defineElementEvent, html, listen} from 'element-vir';
import {fetchApi} from '../../util/api-client.js';
import {defineAppElement} from '../define-app-element.js';
import {VirCommandSettingsModal} from './vir-command-settings-modal.element.js';

/** Edits one repo's `postWorktreeCmd`, the init command run in each of its new worktrees. */
export const VirSidebarBuildSettingsModal = defineAppElement<{
    /** The modal is open while this is set. */
    target:
        | Readonly<{
              repoPath: string;
              repoName: string;
              /** The repo's own command, which seeds the edit. */
              value: string;
              /** Names the global command an empty one falls back to. */
              placeholder: string;
          }>
        | undefined;
}>()({
    tagName: 'vir-sidebar-build-settings-modal',
    events: {
        close: defineElementEvent<void>(),
    },
    state() {
        return {
            isSubmitting: false,
            errorMessage: '',
        };
    },
    render({inputs, state, updateState, dispatch, events, host}) {
        function close() {
            updateState({
                isSubmitting: false,
                errorMessage: '',
            });
            dispatch(
                new events.close({
                    detail: undefined,
                }),
            );
        }

        async function save(value: string) {
            const repoPath = inputs.target?.repoPath;
            if (!repoPath || state.isSubmitting) {
                return;
            }
            updateState({
                isSubmitting: true,
                errorMessage: '',
            });
            try {
                const config = await fetchApi(configEndpoint, HttpMethod.Get);
                await fetchApi(configEndpoint, HttpMethod.Put, {
                    requestData: {
                        ...config,
                        repos: config.repos.map((repo) => {
                            return repo.path === repoPath
                                ? {
                                      ...repo,
                                      /**
                                       * Null falls back to the global command, the same as an
                                       * absent override.
                                       */
                                      postWorktreeCmd: value.trim() || null,
                                  }
                                : repo;
                        }),
                    },
                });
                close();
            } catch (error: unknown) {
                /** The user may have closed the modal while the save was in flight. */
                if (host.instanceInputs.target?.repoPath === repoPath) {
                    updateState({
                        isSubmitting: false,
                        errorMessage: extractErrorMessage(error),
                    });
                }
            }
        }

        return html`
            <${VirCommandSettingsModal.assign({
                open: !!inputs.target,
                modalTitle: `${inputs.target?.repoName || ''} build settings`,
                label: 'Init command (runs in each new worktree)',
                value: inputs.target?.value || '',
                placeholder: inputs.target?.placeholder || '',
                isSubmitting: state.isSubmitting,
                errorMessage: state.errorMessage,
            })}
                ${listen(VirCommandSettingsModal.events.saveRequested, async (event) => {
                    await save(event.detail);
                })}
                ${listen(VirCommandSettingsModal.events.closeRequested, close)}
            ></${VirCommandSettingsModal}>
        `;
    },
});
