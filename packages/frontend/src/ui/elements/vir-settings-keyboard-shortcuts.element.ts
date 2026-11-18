import {type Settings} from '@agent-storm/common';
import {
    defineAppElement,
    formatShortcut,
    isSameShortcut,
    readShortcutFromEvent,
    resolveShortcuts,
    settingsCardCss,
    writeShortcuts,
    type KeyboardShortcut,
    type PluginDefinition,
    type ShortcutAction,
    type ValueUpdate,
} from '@agent-storm/core/frontend';
import {css, defineElementEvent, html, listen, nothing} from 'element-vir';
import {
    createSizedIcon,
    LucidePlusIcon,
    tooltip,
    ViraButton,
    ViraColorVariant,
    ViraEmphasis,
    ViraSize,
    ViraTag,
    viraThemeByKeys,
} from 'vira';

const addIcon = createSizedIcon(LucidePlusIcon, 14);

/**
 * The Settings modal's Keyboard shortcuts section: every running plugin's shortcut actions, each
 * with its current shortcuts for this platform. A new shortcut is recorded from the next key press
 * after its + button.
 */
export const VirSettingsKeyboardShortcuts = defineAppElement<{
    settings: Readonly<Settings>;
    actions: ReadonlyArray<ShortcutAction>;
    plugins: ReadonlyArray<Readonly<Pick<PluginDefinition, 'id' | 'name'>>>;
}>()({
    tagName: 'vir-settings-keyboard-shortcuts',
    events: {
        settingsChange: defineElementEvent<ValueUpdate<Settings>>(),
    },
    state() {
        return {
            /** The action whose new shortcut the next key press records. */
            recordingActionId: undefined as string | undefined,
            /** Removes the recording key listener. */
            stopRecording: undefined as (() => void) | undefined,
        };
    },
    cleanup({state}) {
        state.stopRecording?.();
    },
    styles: css`
        ${settingsCardCss}

        :host {
            display: flex;
            flex-direction: column;
            gap: 16px;
        }

        .card {
            overflow: hidden;
        }

        table {
            width: 100%;
            border-collapse: collapse;
        }

        th {
            padding: 8px 12px;
            text-align: left;
            font-size: 12px;
            font-weight: 600;
            color: ${viraThemeByKeys.grey.foreground['non-body'].foreground.value};
        }

        td {
            padding: 8px 12px;
            vertical-align: middle;
            border-top: 1px solid ${viraThemeByKeys.grey['behind-bg'].decoration.background.value};
        }

        .muted {
            color: ${viraThemeByKeys.grey.foreground['non-body'].foreground.value};
        }

        .shortcuts {
            display: flex;
            flex-wrap: wrap;
            align-items: center;
            gap: 4px;
        }

        .recording {
            font-size: 12px;
        }
    `,
    render({inputs, state, updateState, dispatch, events, host}) {
        function changeShortcuts({
            action,
            change,
        }: Readonly<{
            action: ShortcutAction;
            change(current: ReadonlyArray<KeyboardShortcut>): ReadonlyArray<KeyboardShortcut>;
        }>) {
            dispatch(
                new events.settingsChange({
                    detail(current) {
                        return writeShortcuts({
                            action,
                            settings: current,
                            shortcuts: change(
                                resolveShortcuts({
                                    action,
                                    settings: current,
                                }),
                            ),
                        });
                    },
                }),
            );
        }

        function stopRecording() {
            host.instanceState.stopRecording?.();
            updateState({
                recordingActionId: undefined,
                stopRecording: undefined,
            });
        }

        function startRecording(action: ShortcutAction) {
            stopRecording();
            /**
             * Capture phase on the window, so the press is recorded instead of reaching the app's
             * own shortcuts or the modal's Escape handling.
             */
            function record(event: KeyboardEvent) {
                event.preventDefault();
                event.stopImmediatePropagation();
                const shortcut = readShortcutFromEvent(event);
                if (!shortcut) {
                    return;
                }
                stopRecording();
                if (
                    isSameShortcut({
                        first: shortcut,
                        second: {
                            code: 'Escape',
                        },
                    })
                ) {
                    return;
                }
                changeShortcuts({
                    action,
                    change(current) {
                        return current.some((entry) => {
                            return isSameShortcut({
                                first: entry,
                                second: shortcut,
                            });
                        })
                            ? current
                            : [
                                  ...current,
                                  shortcut,
                              ];
                    },
                });
            }
            globalThis.addEventListener('keydown', record, true);
            updateState({
                recordingActionId: action.id,
                stopRecording() {
                    globalThis.removeEventListener('keydown', record, true);
                },
            });
        }

        if (!inputs.actions.length) {
            return html`
                <span class="muted">No running plugin has keyboard shortcuts.</span>
            `;
        }

        const rows = inputs.actions.map((action) => {
            const isRecording = state.recordingActionId === action.id;
            const shortcuts = resolveShortcuts({
                action,
                settings: inputs.settings,
            });
            return html`
                <tr>
                    <td class="muted">
                        ${inputs.plugins.find((plugin) => plugin.id === action.pluginId)?.name ||
                        action.pluginId}
                    </td>
                    <td>${action.label}</td>
                    <td class="muted">${action.description}</td>
                    <td>
                        <div class="shortcuts">
                            ${shortcuts.map((shortcut) => {
                                return html`
                                    <${ViraTag.assign({
                                        text: formatShortcut(shortcut),
                                        size: ViraSize.Small,
                                        emphasis: ViraEmphasis.Subtle,
                                        color: ViraColorVariant.Neutral,
                                        isClickable: {
                                            cancellable: true,
                                        },
                                    })}
                                        ${listen(ViraTag.events.cancel, () => {
                                            changeShortcuts({
                                                action,
                                                change(current) {
                                                    return current.filter((entry) => {
                                                        return !isSameShortcut({
                                                            first: entry,
                                                            second: shortcut,
                                                        });
                                                    });
                                                },
                                            });
                                        })}
                                    ></${ViraTag}>
                                `;
                            })}
                            ${isRecording
                                ? html`
                                      <span class="muted recording">
                                          Press a shortcut, or Escape to cancel
                                      </span>
                                  `
                                : nothing}
                            <${ViraButton.assign({
                                icon: addIcon,
                                color: ViraColorVariant.Neutral,
                                buttonEmphasis: ViraEmphasis.Subtle,
                                buttonSize: ViraSize.Small,
                            })}
                                ${tooltip(isRecording ? 'Cancel' : 'Add shortcut')}
                                aria-label=${isRecording
                                    ? 'Cancel'
                                    : `Add shortcut for ${action.label}`}
                                ${listen('click', () => {
                                    if (isRecording) {
                                        stopRecording();
                                    } else {
                                        startRecording(action);
                                    }
                                })}
                            ></${ViraButton}>
                        </div>
                    </td>
                </tr>
            `;
        });

        return html`
            <div class="card">
                <table>
                    <thead>
                        <tr>
                            <th>Plugin</th>
                            <th>Action</th>
                            <th>Description</th>
                            <th>Shortcuts</th>
                        </tr>
                    </thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>
        `;
    },
});
