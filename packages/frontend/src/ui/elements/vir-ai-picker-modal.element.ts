import {type AiDefinition} from '@agent-storm/common';
import {css, defineElement, defineElementEvent, html, listen, repeat} from 'element-vir';
import {ViraModal, viraThemeByKeys} from 'vira';
import {reportRenderError} from '../../util/client-error-log.js';
import {VirAiAvatar} from './vir-ai-avatar.element.js';

/**
 * "Change AI" for one target: a folder, a repo (which its worktrees inherit), or a single AI tab.
 * Picking a row applies it immediately — there's no Save step — so the only way out without
 * changing anything is closing the modal. Applying restarts the target's AI pane, since a new
 * command only takes effect on a fresh spawn.
 */
export const VirAiPickerModal = defineElement<{
    open: boolean;
    modalTitle: string;
    aiDefinitions: ReadonlyArray<Readonly<AiDefinition>>;
    /** The target's current override, or empty when it inherits. */
    selectedAiId: string;
    /**
     * Name of the AI this target falls back to with no override of its own, shown on the "Inherit"
     * row. Empty hides that row — a target with nothing to inherit from must pick outright.
     */
    inheritedName: string;
    submitting: boolean;
}>()({
    tagName: 'vir-ai-picker-modal',
    options: {
        errorHandler: reportRenderError,
    },
    events: {
        /** Detail is the chosen id, or empty to clear the override and inherit again. */
        aiSaveRequested: defineElementEvent<string>(),
        closeRequested: defineElementEvent<void>(),
    },
    styles: css`
        .body {
            display: flex;
            flex-direction: column;
            gap: 12px;
            min-width: 280px;
            max-width: 420px;
        }

        .options {
            display: flex;
            flex-direction: column;
            gap: 4px;
        }

        .option {
            display: flex;
            align-items: center;
            gap: 10px;
            padding: 8px 10px;
            border: 1px solid transparent;
            border-radius: 6px;
            cursor: pointer;
            text-align: left;
            appearance: none;
            background: transparent;
            color: inherit;
            font: inherit;
        }

        .option:hover {
            background: ${viraThemeByKeys.grey['behind-fg']['small-body'].background.value};
        }

        .option[data-selected] {
            border-color: ${viraThemeByKeys.blue.foreground.decoration.foreground.value};
            color: ${viraThemeByKeys.blue.foreground.body.foreground.value};
        }

        .option-text {
            display: flex;
            flex-direction: column;
            min-width: 0;
            gap: 2px;
        }

        .option-name {
            font-weight: 600;
        }

        .option-command {
            overflow: hidden;
            white-space: nowrap;
            text-overflow: ellipsis;
            font-family: ui-monospace, monospace;
            font-size: 11px;
            color: ${viraThemeByKeys.grey.foreground['non-body'].foreground.value};
        }

        .empty {
            padding: 8px 2px;
            color: ${viraThemeByKeys.grey.foreground['non-body'].foreground.value};
        }
    `,
    render({inputs, dispatch, events}) {
        const renderOption = ({
            key,
            name,
            detail,
            avatarFile,
        }: Readonly<{key: string; name: string; detail: string; avatarFile: string}>) => html`
            <button
                type="button"
                class="option"
                ?data-selected=${inputs.selectedAiId === key}
                ?disabled=${inputs.submitting}
                ${listen('click', () => dispatch(new events.aiSaveRequested(key)))}
            >
                <${VirAiAvatar.assign({
                    name,
                    avatarFile,
                    sizePx: 24,
                })}></${VirAiAvatar}>
                <span class="option-text">
                    <span class="option-name">${name}</span>
                    <span class="option-command">${detail}</span>
                </span>
            </button>
        `;

        return html`
            <${ViraModal.assign({
                open: inputs.open,
                modalTitle: inputs.modalTitle,
            })}
                ${listen(ViraModal.events.modalClose, () => dispatch(new events.closeRequested()))}
            >
                <div class="body">
                    <div class="options">
                        ${inputs.inheritedName
                            ? renderOption({
                                  key: '',
                                  name: 'Inherit',
                                  detail: inputs.inheritedName,
                                  avatarFile: '',
                              })
                            : ''}
                        ${repeat(
                            inputs.aiDefinitions,
                            (definition) => definition.id,
                            (definition) =>
                                renderOption({
                                    key: definition.id,
                                    name: definition.name,
                                    detail: definition.resumeSessionCommand,
                                    avatarFile: definition.avatarFile || '',
                                }),
                        )}
                    </div>
                    ${inputs.aiDefinitions.length
                        ? ''
                        : html`
                              <div class="empty">
                                  No AI defined yet. Add one from Settings → Define AI.
                              </div>
                          `}
                </div>
            </${ViraModal}>
        `;
    },
});
