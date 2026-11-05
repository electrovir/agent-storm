import {reviewConfigEndpoint} from '@agent-storm/common';
import {extractErrorMessage} from '@augment-vir/common';
import {HttpMethod} from '@rest-vir/api';
import {defineElementEvent, html, listen} from 'element-vir';
import {fetchApi} from '../../util/api-client.js';
import {defineAppElement} from '../define-app-element.js';
import {type InitCmdSettings, toRepoKey} from './review-sidebar-display.js';
import {VirCommandSettingsModal} from './vir-command-settings-modal.element.js';

/** The init command settings modal for one repo or for the default, and its save. */
export const VirReviewSidebarInitCmd = defineAppElement<{
    /** Undefined while the modal is closed. Each opening must pass a new object. */
    settings: Readonly<InitCmdSettings> | undefined;
}>()({
    tagName: 'vir-review-sidebar-init-cmd',
    events: {
        /** Sent when the user closes the modal and after a save succeeds. */
        closed: defineElementEvent<void>(),
    },
    state() {
        return {
            /** The latest save, which only applies while the settings it started from are open. */
            submission: undefined as
                | {
                      settings: Readonly<InitCmdSettings>;
                      value: string;
                      isSubmitting: boolean;
                      errorMessage: string;
                  }
                | undefined,
        };
    },
    render({inputs, state, updateState, host, dispatch, events}) {
        const submission =
            state.submission && state.submission.settings === inputs.settings
                ? state.submission
                : undefined;

        async function save(value: string) {
            const settings = inputs.settings;
            if (!settings || submission?.isSubmitting) {
                return;
            }
            updateState({
                submission: {
                    settings,
                    value,
                    isSubmitting: true,
                    errorMessage: '',
                },
            });
            try {
                const reviewConfig = await fetchApi(reviewConfigEndpoint, HttpMethod.Get);
                const initCmd = value.trim();
                const editedRepo = settings.repo;
                await fetchApi(reviewConfigEndpoint, HttpMethod.Put, {
                    requestData: editedRepo
                        ? {
                              ...reviewConfig,
                              repos: [
                                  ...reviewConfig.repos.filter(
                                      (entry) => toRepoKey(entry) !== toRepoKey(editedRepo),
                                  ),
                                  ...(initCmd
                                      ? [
                                            {
                                                ...editedRepo,
                                                initCmd,
                                            },
                                        ]
                                      : []),
                              ],
                          }
                        : {
                              ...reviewConfig,
                              defaultInitCmd: initCmd,
                          },
                });
                dispatch(
                    new events.closed({
                        detail: undefined,
                    }),
                );
            } catch (error: unknown) {
                /** The user may have closed the modal while the save was in flight. */
                if (host.instanceInputs.settings === settings) {
                    updateState({
                        submission: {
                            settings,
                            value,
                            isSubmitting: false,
                            errorMessage: extractErrorMessage(error),
                        },
                    });
                }
            }
        }

        return html`
            <${VirCommandSettingsModal.assign({
                open: !!inputs.settings,
                modalTitle: inputs.settings?.repo
                    ? `${toRepoKey(inputs.settings.repo)} review settings`
                    : 'Review settings',
                label: inputs.settings?.repo ? 'Init command' : 'Default init command',
                value: submission?.value ?? inputs.settings?.value ?? '',
                placeholder: inputs.settings?.placeholder || '',
                isSubmitting: !!submission?.isSubmitting,
                errorMessage: submission?.errorMessage || '',
            })}
                ${listen(VirCommandSettingsModal.events.saveRequested, async (event) => {
                    await save(event.detail);
                })}
                ${listen(VirCommandSettingsModal.events.closeRequested, () => {
                    dispatch(
                        new events.closed({
                            detail: undefined,
                        }),
                    );
                })}
            ></${VirCommandSettingsModal}>
        `;
    },
});
