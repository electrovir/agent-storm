import {
    type AiDefinition,
    PaneKind,
    restartPaneEndpoint,
    settingsEndpoint,
} from '@agent-storm/common';
import {
    defineAppElement,
    fetchApi,
    type PaneRestartedEvent,
    VirAiPickerModal,
} from '@agent-storm/core/frontend';
import {extractErrorMessage} from '@augment-vir/common';
import {HttpMethod} from '@rest-vir/api';
import {defineElementEvent, html, listen} from 'element-vir';

/**
 * "Change AI" for one sidebar folder. Saving writes the folder's entry in `folderAiIds` (an empty
 * id drops the override so the folder inherits again), then restarts the folder's AI pane so the
 * new command actually takes effect — a running pane keeps whatever it was spawned with.
 */
export const VirSidebarChangeAiModal = defineAppElement<{
    /** The folder being edited, seeded from its current config. The modal is open while this is set. */
    target:
        | Readonly<{
              /** What the override gets written against. */
              folderPath: string;
              /** The folder's current override, or empty when it inherits. */
              selectedAiId: string;
              /**
               * Name of the AI the folder falls back to with no override — a worktree's parent-repo
               * choice if it has one, else the global default.
               */
              inheritedName: string;
              /** A worktree root's choice is inherited by every child that doesn't set its own. */
              isWorktreeRoot: boolean;
          }>
        | undefined;
    aiDefinitions: ReadonlyArray<Readonly<AiDefinition>>;
    hasRunningAiPane: boolean;
}>()({
    tagName: 'vir-sidebar-change-ai-modal',
    events: {
        close: defineElementEvent<void>(),
        /** The new choice is saved. Fired after the restart, if there was one. */
        save: defineElementEvent<void>(),
        paneRestart: defineElementEvent<PaneRestartedEvent>(),
        /** A failure to show in the sidebar's error banner. */
        errorReport: defineElementEvent<string>(),
    },
    state() {
        return {
            isSubmitting: false,
        };
    },
    render({inputs, state, updateState, dispatch, events}) {
        async function save(aiId: string) {
            const folderPath = inputs.target?.folderPath;
            if (!folderPath || state.isSubmitting) {
                return;
            }
            try {
                updateState({
                    isSubmitting: true,
                });
                const settings = await fetchApi(settingsEndpoint, HttpMethod.Get);
                const otherEntries = settings.folderAiIds.filter(
                    (entry) => entry.folder !== folderPath,
                );
                await fetchApi(settingsEndpoint, HttpMethod.Put, {
                    requestData: {
                        ...settings,
                        folderAiIds: aiId
                            ? [
                                  ...otherEntries,
                                  {
                                      folder: folderPath,
                                      aiId,
                                  },
                              ]
                            : otherEntries,
                    },
                });
                /**
                 * Only the edited folder's own AI pane restarts. Worktrees that inherit a root's
                 * choice keep their running agents — killing a batch of in-progress sessions is
                 * never worth applying the change eagerly, and each one picks up the new AI on its
                 * next restart anyway.
                 */
                if (inputs.hasRunningAiPane) {
                    await fetchApi(restartPaneEndpoint, HttpMethod.Post, {
                        requestData: {
                            folder: folderPath,
                            kind: PaneKind.Ai,
                        },
                    });
                    dispatch(
                        new events.paneRestart({
                            detail: {
                                folder: folderPath,
                                kind: PaneKind.Ai,
                            },
                        }),
                    );
                }
                updateState({
                    isSubmitting: false,
                });
                dispatch(
                    new events.save({
                        detail: undefined,
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
            <${VirAiPickerModal.assign({
                open: !!inputs.target,
                modalTitle: inputs.target?.isWorktreeRoot
                    ? 'Change AI (inherited by worktrees)'
                    : 'Change AI',
                aiDefinitions: inputs.aiDefinitions,
                selectedAiId: inputs.target?.selectedAiId || '',
                inheritedName: inputs.target?.inheritedName || '',
                submitting: state.isSubmitting,
            })}
                ${listen(VirAiPickerModal.events.closeRequested, () => {
                    updateState({
                        isSubmitting: false,
                    });
                    dispatch(
                        new events.close({
                            detail: undefined,
                        }),
                    );
                })}
                ${listen(VirAiPickerModal.events.aiSaveRequested, async (event) => {
                    await save(event.detail);
                })}
            ></${VirAiPickerModal}>
        `;
    },
});
