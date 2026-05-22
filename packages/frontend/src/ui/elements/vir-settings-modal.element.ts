import {defaultConfig, type Config} from '@agent-storm/common';
import {css, defineElement, html, listen, onDomCreated} from 'element-vir';
import {type JsonValue} from 'type-fest';
import {
    ViraButton,
    ViraColorVariant,
    ViraJsonForm,
    ViraModal,
    viraThemeByKeys,
    type ViraJsonSchema,
} from 'vira';
import {getConfig, putConfig, restartDaemon} from '../../util/api-client.js';

const configJsonSchema = {
    type: 'object',
    title: 'agent-storm config',
    properties: {
        aiCmd: {
            type: 'string',
            title: 'AI command',
            description: 'Command launched in the AI pane (e.g. `claude`).',
        },
        postWorktreeCmd: {
            type: [
                'string',
                'null',
            ],
            title: 'Default post-worktree command',
            description:
                'Shell command run after a new worktree is created (per-repo overrides win).',
        },
        repos: {
            type: 'array',
            title: 'Repos',
            items: {
                type: 'object',
                title: 'Repo',
                properties: {
                    path: {
                        type: 'string',
                        title: 'Path',
                    },
                    postWorktreeCmd: {
                        type: [
                            'string',
                            'null',
                        ],
                        title: 'Post-worktree command (overrides global)',
                    },
                },
                required: ['path'],
            },
        },
        hiddenAiPane: {
            type: 'array',
            title: 'Folders with AI pane hidden',
            items: {
                type: 'string',
            },
        },
        disabledGitHubPolling: {
            type: 'boolean',
            title: 'Disable GitHub polling',
            description:
                'When on, the sidebar skips `gh pr view` for every folder on each refresh sweep. Turn this on when GitHub is rate-limiting the account — the calls just 403 and the PR badges go stale anyway until the limit resets.',
        },
        useWebgl: {
            type: 'boolean',
            title: 'Use WebGL terminal renderer',
            description:
                "When on, the in-app terminal uses xterm's WebGL renderer (faster on most machines). Turn off to fall back to the DOM renderer on machines without WebGL2 or with flaky GPU drivers. Reloads the page on save when changed so existing terminals pick up the new renderer.",
        },
    },
    required: [
        'aiCmd',
        'repos',
        'hiddenAiPane',
    ],
} as const satisfies ViraJsonSchema;

function toJsonValue(config: Readonly<Config>): JsonValue {
    return JSON.parse(JSON.stringify(config)) as JsonValue;
}

function fromJsonValue(value: JsonValue): Config {
    return {
        ...defaultConfig,
        ...(value as Partial<Config>),
    };
}

export const VirSettingsModal = defineElement<{
    open: boolean;
    onClose: () => void;
}>()({
    tagName: 'vir-settings-modal',
    state() {
        return {
            pending: undefined as JsonValue | undefined,
            /**
             * The useWebgl value at load time, captured so save() can detect a flip and trigger a
             * page reload — existing terminals only read the config at construction.
             */
            useWebgl: undefined as boolean | undefined,
            loadError: undefined as string | undefined,
            saveError: undefined as string | undefined,
            saving: false,
            restartingDaemon: false,
            daemonRestartError: undefined as string | undefined,
        };
    },
    styles: css`
        .body {
            display: flex;
            flex-direction: column;
            gap: 16px;
            min-width: 540px;
            max-width: 720px;
        }

        .footer {
            display: flex;
            justify-content: flex-end;
            gap: 8px;
        }

        .error {
            padding: 8px 12px;
            border-radius: 6px;
            border: 1px solid currentColor;
            color: ${viraThemeByKeys.red.foreground.body.foreground.value};
            background: ${viraThemeByKeys.red['behind-bg'].body.background.value};
            white-space: pre-wrap;
        }

        .loading {
            padding: 24px;
            text-align: center;
            color: ${viraThemeByKeys.grey.foreground.body.foreground.value};
        }
    `,
    render({inputs, state, updateState}) {
        const reset = () => {
            updateState({
                pending: undefined,
                useWebgl: undefined,
                loadError: undefined,
                saveError: undefined,
                saving: false,
                restartingDaemon: false,
                daemonRestartError: undefined,
            });
        };

        const restartDaemonAction = async () => {
            if (
                !window.confirm(
                    'Restart the PTY daemon? All running terminal sessions will be killed.',
                )
            ) {
                return;
            }
            updateState({
                restartingDaemon: true,
                daemonRestartError: undefined,
            });
            try {
                await restartDaemon();
                updateState({
                    restartingDaemon: false,
                });
            } catch (error: unknown) {
                updateState({
                    restartingDaemon: false,
                    daemonRestartError: error instanceof Error ? error.message : String(error),
                });
            }
        };

        const load = async () => {
            try {
                const config = await getConfig();
                updateState({
                    pending: toJsonValue(config),
                    // optionalShape default is true; coerce undefined → true for comparison.
                    useWebgl: config.useWebgl !== false,
                    loadError: undefined,
                });
            } catch (error: unknown) {
                updateState({
                    loadError: error instanceof Error ? error.message : String(error),
                });
            }
        };

        const save = async () => {
            if (!state.pending || state.saving) {
                return;
            }
            updateState({
                saving: true,
                saveError: undefined,
            });
            try {
                const next = fromJsonValue(state.pending);
                await putConfig(next);
                const nextUseWebgl = next.useWebgl !== false;
                const webglChanged =
                    state.useWebgl !== undefined && state.useWebgl !== nextUseWebgl;
                reset();
                inputs.onClose();
                if (webglChanged) {
                    // Existing terminals only read useWebgl at construction; reload so the
                    // new renderer choice applies everywhere.
                    window.location.reload();
                }
            } catch (error: unknown) {
                updateState({
                    saving: false,
                    saveError: error instanceof Error ? error.message : String(error),
                });
            }
        };

        return html`
            <${ViraModal.assign({
                open: inputs.open,
                modalTitle: 'Settings',
            })}
                ${listen(ViraModal.events.modalClose, () => {
                    reset();
                    inputs.onClose();
                })}
            >
                ${inputs.open
                    ? html`
                          <div
                              class="body"
                              ${onDomCreated(() => {
                                  if (!state.pending && !state.loadError) {
                                      void load();
                                  }
                              })}
                          >
                              ${state.loadError
                                  ? html`
                                        <div class="error">${state.loadError}</div>
                                    `
                                  : ''}
                              ${state.saveError
                                  ? html`
                                        <div class="error">${state.saveError}</div>
                                    `
                                  : ''}
                              ${state.daemonRestartError
                                  ? html`
                                        <div class="error">${state.daemonRestartError}</div>
                                    `
                                  : ''}
                              ${state.pending
                                  ? html`
                                        <${ViraJsonForm.assign({
                                            value: state.pending,
                                            schema: configJsonSchema,
                                            isDisabled: state.saving,
                                        })}
                                            ${listen(ViraJsonForm.events.valueChange, (event) => {
                                                updateState({
                                                    pending: event.detail,
                                                });
                                            })}
                                        ></${ViraJsonForm}>
                                    `
                                  : state.loadError
                                    ? ''
                                    : html`
                                          <div class="loading">Loading config...</div>
                                      `}
                              <div class="footer">
                                  <${ViraButton.assign({
                                      text: state.restartingDaemon
                                          ? 'Restarting daemon...'
                                          : 'Restart PTY daemon',
                                      color: ViraColorVariant.Danger,
                                      isDisabled: state.restartingDaemon || state.saving,
                                  })}
                                      ${listen('click', () => void restartDaemonAction())}
                                  ></${ViraButton}>
                                  <span style="flex-grow: 1;"></span>
                                  <${ViraButton.assign({
                                      text: 'Cancel',
                                      color: ViraColorVariant.Neutral,
                                      isDisabled: state.saving,
                                  })}
                                      ${listen('click', () => {
                                          reset();
                                          inputs.onClose();
                                      })}
                                  ></${ViraButton}>
                                  <${ViraButton.assign({
                                      text: state.saving ? 'Saving...' : 'Save',
                                      color: ViraColorVariant.Brand,
                                      isDisabled: state.saving || !state.pending,
                                  })}
                                      ${listen('click', () => void save())}
                                  ></${ViraButton}>
                              </div>
                          </div>
                      `
                    : ''}
            </${ViraModal}>
        `;
    },
});
