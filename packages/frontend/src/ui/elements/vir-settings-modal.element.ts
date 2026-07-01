import {
    defaultConfig,
    type Config,
    type RepoConfig,
    type UserThemeSelection,
} from '@agent-storm/common';
import {css, defineElement, html, listen, onDomCreated} from 'element-vir';
import {
    lucideIcons,
    ViraButton,
    ViraCheckbox,
    ViraColorVariant,
    ViraIcon,
    ViraInput,
    ViraModal,
    ViraSize,
    ViraTextArea,
} from 'vira';
import {deleteRepo, getConfig, putConfig, restartDaemon} from '../../util/api-client.js';
import {router} from '../../util/router.js';
import {themeClient} from '../../util/theme.js';
import {viraButtonOverrides} from '../button-overrides.styles.js';
import {VirAppearanceSection} from './vir-appearance-section.element.js';

type EditableConfig = Omit<Config, 'repos'>;

function toEditable(config: Readonly<Config>): EditableConfig {
    // Strip `repos` (managed separately by the modal) and pass every other Config
    // field through so optional flags like useWebgl / disabledGitHubPolling survive a save.
    const {repos: _repos, ...rest} = config;
    return rest;
}

function mergeEdits(current: Readonly<Config>, edits: EditableConfig): Config {
    // Spread `current` first so any Config fields the UI doesn't expose
    // (e.g. useWebgl, disabledGitHubPolling, the backend-managed githubPollingAutoDisable)
    // survive the save instead of collapsing back to defaults.
    return {
        ...defaultConfig,
        ...current,
        ...edits,
        repos: current.repos,
    };
}

export const VirSettingsModal = defineElement<{
    open: boolean;
    onClose: () => void;
}>()({
    tagName: 'vir-settings-modal',
    state() {
        return {
            pending: undefined as EditableConfig | undefined,
            repos: undefined as ReadonlyArray<RepoConfig> | undefined,
            themeSelection: themeClient.getSelection(),
            /**
             * `useWebgl` at load time. Captured so save() can detect a flip and reload the page —
             * existing vir-terminal instances only read the renderer choice at construction, so
             * a save without a reload would leave running terminals on the old renderer.
             */
            originalUseWebgl: undefined as boolean | undefined,
            loadError: undefined as string | undefined,
            saveError: undefined as string | undefined,
            saving: false,
            restartingDaemon: false,
            daemonRestartError: undefined as string | undefined,
            deletingRepoPath: undefined as string | undefined,
            deleteRepoError: undefined as string | undefined,
        };
    },
    styles: css`
        .body {
            display: flex;
            flex-direction: column;
            gap: 24px;
            width: 620px;
            max-width: 100%;
            font-family: var(--font-body);
            color: var(--fg);
        }

        .section {
            display: flex;
            flex-direction: column;
            gap: 16px;
            padding: 18px 20px;
            border: 1px solid var(--border-subtle);
            border-radius: var(--radius-panel-md);
            background: var(--bg-muted);
        }

        .section-header {
            display: flex;
            flex-direction: column;
            gap: 4px;
        }

        .section-title {
            font-size: var(--font-size-md);
            font-weight: var(--font-weight-semibold);
            color: var(--fg-emphasized);
            letter-spacing: -0.005em;
        }

        .section-subtitle {
            font-size: var(--font-size-xs);
            line-height: var(--line-height-xs);
            color: var(--fg-muted);
        }

        .section-danger {
            border-color: color-mix(in srgb, var(--red-700) 50%, transparent);
            background: color-mix(in srgb, var(--red-950) 60%, transparent);
        }

        .section-danger .section-title {
            color: var(--fg-error);
        }

        .field {
            display: flex;
            flex-direction: column;
            gap: 6px;
        }

        .field-label {
            font-size: var(--font-size-sm);
            font-weight: var(--font-weight-medium);
            color: var(--fg-emphasized);
        }

        .field-help {
            font-size: var(--font-size-xs);
            line-height: var(--line-height-xs);
            color: var(--fg-muted);
        }

        .field-help code {
            font-family: var(--font-mono);
            font-size: 0.9em;
            padding: 1px 5px;
            border-radius: var(--radius-xs);
            background: var(--bg-emphasized);
            color: var(--fg-subtle);
        }

        vira-input,
        vira-text-area {
            --vira-input-border-radius: var(--radius-control-md);
            --vira-text-area-border-radius: var(--radius-control-md);
            font-family: var(--font-body);
        }

        .hidden-list {
            display: flex;
            flex-direction: column;
            gap: 6px;
        }

        .hidden-row {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 8px 10px 8px 12px;
            border-radius: var(--radius-control-md);
            background: var(--bg-emphasized);
            border: 1px solid var(--border-subtle);
            font-family: var(--font-mono);
            font-size: var(--font-size-xs);
            color: var(--fg-subtle);
        }

        .hidden-path {
            flex-grow: 1;
            min-width: 0;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }

        .hidden-empty {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 14px;
            border-radius: var(--radius-control-md);
            border: 1px dashed var(--border-subtle);
            color: var(--fg-muted);
            font-size: var(--font-size-xs);
            justify-content: center;
        }

        .action-row {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 16px;
        }

        .action-text {
            display: flex;
            flex-direction: column;
            gap: 2px;
            min-width: 0;
        }

        .action-title {
            font-size: var(--font-size-sm);
            font-weight: var(--font-weight-medium);
            color: var(--fg-emphasized);
        }

        .action-desc {
            font-size: var(--font-size-xs);
            line-height: var(--line-height-xs);
            color: var(--fg-muted);
        }

        .footer {
            display: flex;
            justify-content: flex-end;
            gap: 10px;
            padding-top: 16px;
            border-top: 1px solid var(--border-subtle);
        }

        .error {
            display: flex;
            align-items: flex-start;
            gap: 8px;
            padding: 10px 12px;
            border-radius: var(--radius-md);
            border: 1px solid var(--border-error);
            color: var(--fg-error);
            background: var(--bg-error);
            font-size: var(--font-size-sm);
            line-height: var(--line-height-sm);
            white-space: pre-wrap;
        }

        .error vira-icon {
            flex-shrink: 0;
            margin-top: 2px;
        }

        .loading {
            padding: 40px;
            text-align: center;
            color: var(--fg-muted);
            font-size: var(--font-size-sm);
        }

        ${viraButtonOverrides}
    `,
    render({inputs, state, updateState}) {
        const reset = () => {
            updateState({
                pending: undefined,
                repos: undefined,
                originalUseWebgl: undefined,
                loadError: undefined,
                saveError: undefined,
                saving: false,
                restartingDaemon: false,
                daemonRestartError: undefined,
                deletingRepoPath: undefined,
                deleteRepoError: undefined,
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
                    pending: toEditable(config),
                    repos: config.repos,
                    // optionalShape default is true; coerce undefined → true for comparison.
                    originalUseWebgl: config.useWebgl !== false,
                    loadError: undefined,
                });
            } catch (error: unknown) {
                updateState({
                    loadError: error instanceof Error ? error.message : String(error),
                });
            }
        };

        const deleteRepoAction = async (repoPath: string) => {
            if (
                state.deletingRepoPath ||
                !window.confirm(
                    `Remove ${repoPath} from agent-storm?\n\nThis only unregisters the repo from the workspace. Files on disk are left untouched.`,
                )
            ) {
                return;
            }
            updateState({
                deletingRepoPath: repoPath,
                deleteRepoError: undefined,
            });
            try {
                await deleteRepo(repoPath);
                updateState({
                    deletingRepoPath: undefined,
                    repos: (state.repos ?? []).filter((repo) => repo.path !== repoPath),
                });
            } catch (error: unknown) {
                updateState({
                    deletingRepoPath: undefined,
                    deleteRepoError: error instanceof Error ? error.message : String(error),
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
                const current = await getConfig();
                const next = mergeEdits(current, state.pending);
                await putConfig(next);
                const nextUseWebgl = next.useWebgl !== false;
                const webglFlipped =
                    state.originalUseWebgl !== undefined &&
                    state.originalUseWebgl !== nextUseWebgl;
                reset();
                inputs.onClose();
                if (webglFlipped) {
                    // vir-terminal reads useWebgl once at construction, so flipping the toggle
                    // doesn't affect already-mounted terminals. Reload so every pane picks up
                    // the new renderer immediately.
                    window.location.reload();
                }
            } catch (error: unknown) {
                updateState({
                    saving: false,
                    saveError: error instanceof Error ? error.message : String(error),
                });
            }
        };

        const patch = (partial: Partial<EditableConfig>) => {
            if (!state.pending) {
                return;
            }
            updateState({
                pending: {
                    ...state.pending,
                    ...partial,
                },
            });
        };

        const onThemeChange = (next: UserThemeSelection) => {
            themeClient.applyTheme(next);
            updateState({
                themeSelection: next,
            });
        };

        const removeHidden = (path: string) => {
            if (!state.pending) {
                return;
            }
            patch({
                hiddenAiPane: state.pending.hiddenAiPane.filter((entry) => entry !== path),
            });
        };

        return html`
            <${ViraModal.assign({
                open: inputs.open,
                modalTitle: 'Settings',
                modalSubtitle: 'Configure agent-storm behavior for this workspace.',
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
                              <${VirAppearanceSection.assign({
                                  theme: state.themeSelection,
                              })}
                                  ${listen(VirAppearanceSection.events.themeChange, (event) => {
                                      onThemeChange(event.detail);
                                  })}
                              ></${VirAppearanceSection}>
                              ${state.loadError
                                  ? html`
                                        <div class="error">
                                            <${ViraIcon.assign({
                                                icon: lucideIcons.CircleAlert,
                                            })}></${ViraIcon}>
                                            <span>${state.loadError}</span>
                                        </div>
                                    `
                                  : ''}
                              ${state.saveError
                                  ? html`
                                        <div class="error">
                                            <${ViraIcon.assign({
                                                icon: lucideIcons.CircleAlert,
                                            })}></${ViraIcon}>
                                            <span>${state.saveError}</span>
                                        </div>
                                    `
                                  : ''}
                              ${state.daemonRestartError
                                  ? html`
                                        <div class="error">
                                            <${ViraIcon.assign({
                                                icon: lucideIcons.CircleAlert,
                                            })}></${ViraIcon}>
                                            <span>${state.daemonRestartError}</span>
                                        </div>
                                    `
                                  : ''}
                              ${state.deleteRepoError
                                  ? html`
                                        <div class="error">
                                            <${ViraIcon.assign({
                                                icon: lucideIcons.CircleAlert,
                                            })}></${ViraIcon}>
                                            <span>${state.deleteRepoError}</span>
                                        </div>
                                    `
                                  : ''}
                              ${state.pending
                                  ? renderSections({
                                        state: state.pending,
                                        patch,
                                        removeHidden,
                                    })
                                  : state.loadError
                                    ? ''
                                    : html`
                                          <div class="loading">Loading config…</div>
                                      `}
                              ${state.pending
                                  ? renderDeveloperToolsSection({
                                        onOpenBook: () => {
                                            reset();
                                            inputs.onClose();
                                            router.setRoute({
                                                paths: ['book'],
                                            });
                                        },
                                    })
                                  : ''}
                              ${state.pending
                                  ? renderDangerZone({
                                        restarting: state.restartingDaemon,
                                        saving: state.saving,
                                        repos: state.repos ?? [],
                                        deletingRepoPath: state.deletingRepoPath,
                                        onRestart: restartDaemonAction,
                                        onDeleteRepo: deleteRepoAction,
                                    })
                                  : ''}
                              <div class="footer">
                                  <${ViraButton.assign({
                                      text: 'Cancel',
                                      color: ViraColorVariant.Neutral,
                                      buttonSize: ViraSize.Medium,
                                      isDisabled: state.saving,
                                  })}
                                      ${listen('click', () => {
                                          reset();
                                          inputs.onClose();
                                      })}
                                  ></${ViraButton}>
                                  <${ViraButton.assign({
                                      text: state.saving ? 'Saving…' : 'Save changes',
                                      color: ViraColorVariant.Brand,
                                      buttonSize: ViraSize.Medium,
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

function renderSections({
    state,
    patch,
    removeHidden,
}: Readonly<{
    state: EditableConfig;
    patch: (partial: Partial<EditableConfig>) => void;
    removeHidden: (path: string) => void;
}>) {
    return html`
        <section class="section">
            <div class="section-header">
                <span class="section-title">General</span>
                <span class="section-subtitle">
                    Defaults applied across every repo. Per-repo overrides take precedence.
                </span>
            </div>
            <div class="field">
                <label class="field-label" for="settings-ai-cmd">AI command</label>
                <${ViraInput.assign({
                    value: state.aiCmd,
                    placeholder: 'claude',
                })}
                    id="settings-ai-cmd"
                    ${listen(ViraInput.events.valueChange, (event) => {
                        patch({
                            aiCmd: event.detail,
                        });
                    })}
                ></${ViraInput}>
                <span class="field-help">
                    Command launched in each AI pane, e.g.
                    <code>claude</code>
                    or
                    <code>aider --model sonnet</code>
                    .
                </span>
            </div>
            <div class="field">
                <label class="field-label" for="settings-post-worktree">
                    Default post-worktree command
                </label>
                <${ViraTextArea.assign({
                    value: state.postWorktreeCmd ?? '',
                    placeholder: 'npm install && cp ../.env .env',
                    rows: 3,
                })}
                    id="settings-post-worktree"
                    ${listen(ViraTextArea.events.valueChange, (event) => {
                        const trimmed = event.detail;
                        patch({
                            postWorktreeCmd: trimmed.length === 0 ? null : trimmed,
                        });
                    })}
                ></${ViraTextArea}>
                <span class="field-help">
                    Shell command run after a new worktree is created. Leave empty to skip.
                    Individual repos can override this in their config.
                </span>
            </div>
            <div class="field">
                <${ViraCheckbox.assign({
                    value: state.useWebgl !== false,
                    label: 'Use WebGL terminal renderer',
                })}
                    ${listen(ViraCheckbox.events.valueChange, (event) => {
                        patch({useWebgl: event.detail});
                    })}
                ></${ViraCheckbox}>
                <span class="field-help">
                    Faster on most machines. Turn off to fall back to xterm's DOM renderer if
                    WebGL2 is unavailable or GPU drivers are flaky. Saving a change reloads the
                    page so live terminals pick up the new renderer.
                </span>
            </div>
        </section>

        <section class="section">
            <div class="section-header">
                <span class="section-title">Hidden AI panes</span>
                <span class="section-subtitle">
                    Folders where the AI pane stays collapsed. Use the eye icon in the sidebar to
                    add new entries; remove them here.
                </span>
            </div>
            ${state.hiddenAiPane.length === 0
                ? html`
                      <div class="hidden-empty">
                          <${ViraIcon.assign({
                              icon: lucideIcons.EyeOff,
                          })}></${ViraIcon}>
                          <span>No hidden AI panes.</span>
                      </div>
                  `
                : html`
                      <div class="hidden-list">
                          ${state.hiddenAiPane.map(
                              (path) => html`
                                  <div class="hidden-row">
                                      <${ViraIcon.assign({
                                          icon: lucideIcons.Folder,
                                      })}></${ViraIcon}>
                                      <span class="hidden-path" title=${path}>${path}</span>
                                      <${ViraButton.assign({
                                          icon: lucideIcons.X,
                                          buttonSize: ViraSize.Small,
                                          color: ViraColorVariant.Neutral,
                                      })}
                                          title="Remove from hidden list"
                                          ${listen('click', () => removeHidden(path))}
                                      ></${ViraButton}>
                                  </div>
                              `,
                          )}
                      </div>
                  `}
        </section>
    `;
}

function renderDeveloperToolsSection({
    onOpenBook,
}: Readonly<{
    onOpenBook: () => void;
}>) {
    return html`
        <section class="section">
            <div class="section-header">
                <span class="section-title">Developer tools</span>
                <span class="section-subtitle">
                    Internal utilities for browsing the agent-storm UI components.
                </span>
            </div>
            <div class="action-row">
                <div class="action-text">
                    <span class="action-title">Element book</span>
                    <span class="action-desc">
                        Browse every UI element registered in agent-storm with live previews.
                    </span>
                </div>
                <${ViraButton.assign({
                    text: 'See element book',
                    icon: lucideIcons.BookOpen,
                    color: ViraColorVariant.Neutral,
                    buttonSize: ViraSize.Medium,
                })}
                    ${listen('click', () => onOpenBook())}
                ></${ViraButton}>
            </div>
        </section>
    `;
}

function renderDangerZone({
    restarting,
    saving,
    repos,
    deletingRepoPath,
    onRestart,
    onDeleteRepo,
}: Readonly<{
    restarting: boolean;
    saving: boolean;
    repos: ReadonlyArray<RepoConfig>;
    deletingRepoPath: string | undefined;
    onRestart: () => void | Promise<void>;
    onDeleteRepo: (repoPath: string) => void | Promise<void>;
}>) {
    return html`
        <section class="section section-danger">
            <div class="section-header">
                <span class="section-title">Danger zone</span>
                <span class="section-subtitle">Actions here can disrupt running work.</span>
            </div>
            <div class="action-row">
                <div class="action-text">
                    <span class="action-title">Restart PTY daemon</span>
                    <span class="action-desc">
                        Kills every running terminal session and respawns the daemon. Use this if
                        panes have become unresponsive.
                    </span>
                </div>
                <${ViraButton.assign({
                    text: restarting ? 'Restarting…' : 'Restart daemon',
                    icon: lucideIcons.RotateCw,
                    color: ViraColorVariant.Danger,
                    buttonSize: ViraSize.Medium,
                    isDisabled: restarting || saving,
                })}
                    ${listen('click', () => void onRestart())}
                ></${ViraButton}>
            </div>
            <div class="action-text">
                <span class="action-title">Delete repositories</span>
                <span class="action-desc">
                    Unregisters a repo from agent-storm. Files on disk are left untouched; you can
                    re-add the folder later from the sidebar.
                </span>
            </div>
            ${repos.length === 0
                ? html`
                      <div class="hidden-empty">
                          <${ViraIcon.assign({
                              icon: lucideIcons.FolderX,
                          })}></${ViraIcon}>
                          <span>No repositories registered.</span>
                      </div>
                  `
                : html`
                      <div class="hidden-list">
                          ${repos.map((repo) => {
                              const isDeleting = deletingRepoPath === repo.path;
                              const otherDeleting = deletingRepoPath !== undefined && !isDeleting;
                              return html`
                                  <div class="hidden-row">
                                      <${ViraIcon.assign({
                                          icon: lucideIcons.Folder,
                                      })}></${ViraIcon}>
                                      <span class="hidden-path" title=${repo.path}>
                                          ${repo.path}
                                      </span>
                                      <${ViraButton.assign({
                                          text: isDeleting ? 'Deleting…' : 'Delete',
                                          icon: lucideIcons.Trash2,
                                          buttonSize: ViraSize.Small,
                                          color: ViraColorVariant.Danger,
                                          isDisabled: isDeleting || otherDeleting || saving,
                                      })}
                                          title="Unregister this repository"
                                          ${listen('click', () => void onDeleteRepo(repo.path))}
                                      ></${ViraButton}>
                                  </div>
                              `;
                          })}
                      </div>
                  `}
        </section>
    `;
}
