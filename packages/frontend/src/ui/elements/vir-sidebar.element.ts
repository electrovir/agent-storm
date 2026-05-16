import {type FolderInfo, PaneKind, PaneStatus} from '@agent-storm/common';
import {colorCss} from '@electrovir/color';
import {css, defineElement, html, listen} from 'element-vir';
import {lucideIcons, ViraButton, ViraColorVariant, ViraSize, viraThemeByKeys} from 'vira';
import {
    createWorktree,
    deleteWorktree,
    getConfig,
    getFolders,
    killFolderPanes,
    putConfig,
    restartPane,
} from '../../util/api-client.js';

const pollIntervalMs = 2_000;

const paneStatusGlyph: Record<PaneStatus, string> = {
    [PaneStatus.None]: '·',
    [PaneStatus.Busy]: '●',
    [PaneStatus.Idle]: '○',
    [PaneStatus.Exited]: '✕',
};

const paneStatusColor: Record<PaneStatus, string> = {
    [PaneStatus.None]: String(viraThemeByKeys.grey.foreground.decoration.foreground.value),
    [PaneStatus.Busy]: String(viraThemeByKeys.green.foreground.body.foreground.value),
    [PaneStatus.Idle]: String(viraThemeByKeys.grey.foreground.body.foreground.value),
    [PaneStatus.Exited]: String(viraThemeByKeys.red.foreground.body.foreground.value),
};

type SidebarState = {
    folders: ReadonlyArray<FolderInfo>;
    pollHandle: ReturnType<typeof setInterval> | undefined;
    loadError: string | undefined;
};

type SidebarUpdate = (newState: Partial<SidebarState>) => void;

export const VirSidebar = defineElement<{
    activeFolder: string | undefined;
    onActivate: (folder: string) => void;
    onOpenSettings: () => void;
}>()({
    tagName: 'vir-sidebar',
    state(): SidebarState {
        return {
            folders: [],
            pollHandle: undefined,
            loadError: undefined,
        };
    },
    styles: css`
        :host {
            display: flex;
            flex-direction: column;
            height: 100%;
            font-family: ui-sans-serif, system-ui, sans-serif;
            font-size: 12px;
            border-right: 1px solid
                ${viraThemeByKeys.grey['behind-bg'].decoration.background.value};
            overflow: hidden;
            ${colorCss(viraThemeByKeys.grey['behind-bg'].decoration)};
        }

        .header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 8px 10px;
            border-bottom: 1px solid
                ${viraThemeByKeys.grey['behind-bg'].decoration.background.value};
            gap: 6px;
        }

        .title {
            font-weight: 600;
            letter-spacing: 0.04em;
            text-transform: uppercase;
            color: ${viraThemeByKeys.grey.foreground.header.foreground.value};
            font-size: 11px;
        }

        .header-actions {
            display: flex;
            gap: 6px;
            align-items: center;
        }

        .list {
            flex-grow: 1;
            overflow-y: auto;
            padding: 4px 0;
        }

        .repo-header {
            padding: 6px 10px 2px;
            color: ${viraThemeByKeys.grey.foreground.header.foreground.value};
            font-size: 11px;
            text-transform: uppercase;
            letter-spacing: 0.04em;
            display: flex;
            justify-content: space-between;
            align-items: center;
            gap: 6px;
        }

        .row {
            display: flex;
            align-items: center;
            gap: 6px;
            padding: 4px 10px;
            cursor: pointer;
            user-select: none;
        }

        .row:hover {
            ${colorCss(viraThemeByKeys.grey['behind-bg'].placeholder)};
        }

        .row[data-active] {
            ${colorCss(viraThemeByKeys.blue['behind-bg'].placeholder)};
        }

        .row[data-indented] {
            padding-left: 22px;
        }

        .chips {
            display: inline-flex;
            gap: 2px;
            font-size: 11px;
            font-family: ui-monospace, monospace;
        }

        .chip {
            width: 10px;
            text-align: center;
        }

        .name {
            flex-grow: 1;
            min-width: 0;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }

        .name[data-pr-open] {
            text-decoration: underline;
            text-decoration-color: ${viraThemeByKeys.blue.foreground.body.foreground.value};
        }

        .name[data-pr-merged] {
            text-decoration: underline;
            text-decoration-color: ${viraThemeByKeys.purple.foreground.body.foreground.value};
        }

        .markers {
            color: ${viraThemeByKeys.yellow.foreground.body.foreground.value};
            font-weight: 700;
        }

        .actions {
            display: inline-flex;
            gap: 2px;
            opacity: 0;
        }

        .row:hover .actions,
        .repo-header:hover .actions {
            opacity: 1;
        }

        .error {
            padding: 8px 10px;
            ${colorCss(viraThemeByKeys.red['behind-bg'].body)};
            border-bottom: 1px solid
                ${viraThemeByKeys.red['behind-bg'].decoration.background.value};
            white-space: pre-wrap;
        }

        .empty {
            padding: 16px 10px;
            color: ${viraThemeByKeys.grey.foreground.placeholder.foreground.value};
            text-align: center;
        }
    `,
    init({state, updateState}) {
        void refresh(state, updateState);
        const pollHandle = setInterval(() => {
            void refresh(state, updateState);
        }, pollIntervalMs);
        updateState({pollHandle});
    },
    cleanup({state}) {
        if (state.pollHandle) {
            clearInterval(state.pollHandle);
        }
    },
    render({inputs, state, updateState}) {
        const standalones = state.folders.filter(
            (folder) => !folder.isWorktreeRoot && !folder.parentRepoPath,
        );
        const worktreeRoots = state.folders.filter((folder) => folder.isWorktreeRoot);

        return html`
            <div class="header">
                <span class="title">Repos</span>
                <span class="header-actions">
                    <${ViraButton.assign({
                        text: 'Add',
                        icon: lucideIcons.Plus,
                        buttonSize: ViraSize.Small,
                        color: ViraColorVariant.Brand,
                    })}
                        ${listen('click', () => void promptAddRepo(updateState))}
                    ></${ViraButton}>
                    <${ViraButton.assign({
                        icon: lucideIcons.Settings,
                        buttonSize: ViraSize.Small,
                        color: ViraColorVariant.Neutral,
                    })}
                        ${listen('click', () => inputs.onOpenSettings())}
                    ></${ViraButton}>
                </span>
            </div>
            ${state.loadError
                ? html`
                      <div class="error">${state.loadError}</div>
                  `
                : ''}
            <div class="list">
                ${state.folders.length === 0 && !state.loadError
                    ? html`
                          <div class="empty">No repos configured. Click + to add one.</div>
                      `
                    : ''}
                ${standalones.map((folder) =>
                    renderRow({
                        folder,
                        indented: false,
                        activeFolder: inputs.activeFolder,
                        onActivate: inputs.onActivate,
                        updateState,
                    }),
                )}
                ${worktreeRoots.map((root) => {
                    const children = state.folders.filter(
                        (folder) => folder.parentRepoPath === root.path,
                    );
                    return html`
                        <div class="repo-header">
                            <span>${root.name}</span>
                            <span class="actions">
                                <${ViraButton.assign({
                                    icon: lucideIcons.GitBranchPlus,
                                    buttonSize: ViraSize.Small,
                                    color: ViraColorVariant.Neutral,
                                })}
                                    title="Add worktree"
                                    ${listen(
                                        'click',
                                        () => void promptAddWorktree(root.path, updateState),
                                    )}
                                ></${ViraButton}>
                                <${ViraButton.assign({
                                    icon: lucideIcons.X,
                                    buttonSize: ViraSize.Small,
                                    color: ViraColorVariant.Danger,
                                })}
                                    title="Remove repo"
                                    ${listen(
                                        'click',
                                        () => void confirmRemoveRepo(root.path, updateState),
                                    )}
                                ></${ViraButton}>
                            </span>
                        </div>
                        ${children.map((child) =>
                            renderRow({
                                folder: child,
                                indented: true,
                                activeFolder: inputs.activeFolder,
                                onActivate: inputs.onActivate,
                                updateState,
                            }),
                        )}
                    `;
                })}
            </div>
        `;
    },
});

function renderRow({
    folder,
    indented,
    activeFolder,
    onActivate,
    updateState,
}: Readonly<{
    folder: FolderInfo;
    indented: boolean;
    activeFolder: string | undefined;
    onActivate: (folder: string) => void;
    updateState: SidebarUpdate;
}>) {
    const markers = [
        folder.git.dirty ? '*' : '',
        folder.git.unpushed ? '+' : '',
    ].join('');
    return html`
        <div
            class="row"
            ?data-active=${activeFolder === folder.path}
            ?data-indented=${indented}
            ${listen('click', () => onActivate(folder.path))}
        >
            <span class="chips">
                <span
                    class="chip"
                    style="color: ${paneStatusColor[folder.panes.ai]};"
                    title="AI pane: ${folder.panes.ai}"
                >
                    ${paneStatusGlyph[folder.panes.ai]}
                </span>
                <span
                    class="chip"
                    style="color: ${paneStatusColor[folder.panes.shell]};"
                    title="Shell pane: ${folder.panes.shell}"
                >
                    ${paneStatusGlyph[folder.panes.shell]}
                </span>
            </span>
            <span
                class="name"
                ?data-pr-open=${!!folder.prUrl && !folder.prMerged}
                ?data-pr-merged=${!!folder.prUrl && folder.prMerged}
            >
                ${folder.name}
            </span>
            <span class="markers">${markers}</span>
            <span class="actions">
                ${folder.prUrl
                    ? html`
                          <${ViraButton.assign({
                              icon: lucideIcons.ExternalLink,
                              buttonSize: ViraSize.Small,
                              color: ViraColorVariant.Info,
                          })}
                              title="Open PR"
                              ${listen('click', (event) => {
                                  event.stopPropagation();
                                  window.open(folder.prUrl || '', '_blank', 'noopener');
                              })}
                          ></${ViraButton}>
                      `
                    : ''}
                <${ViraButton.assign({
                    icon: folder.aiHidden ? lucideIcons.EyeOff : lucideIcons.Eye,
                    buttonSize: ViraSize.Small,
                    color: ViraColorVariant.Neutral,
                })}
                    title="Toggle AI pane"
                    ${listen('click', (event) => {
                        event.stopPropagation();
                        void toggleAiHidden(folder.path, updateState);
                    })}
                ></${ViraButton}>
                <${ViraButton.assign({
                    icon: lucideIcons.RotateCw,
                    buttonSize: ViraSize.Small,
                    color: ViraColorVariant.Neutral,
                })}
                    title="Restart AI"
                    ${listen('click', (event) => {
                        event.stopPropagation();
                        void restartPane({folder: folder.path, kind: PaneKind.Ai}).catch(
                            (error: unknown) => showError(updateState, error),
                        );
                    })}
                ></${ViraButton}>
                <${ViraButton.assign({
                    icon: lucideIcons.PowerOff,
                    buttonSize: ViraSize.Small,
                    color: ViraColorVariant.Warning,
                })}
                    title="Kill folder panes"
                    ${listen('click', (event) => {
                        event.stopPropagation();
                        void killFolderPanes({folder: folder.path}).catch((error: unknown) =>
                            showError(updateState, error),
                        );
                    })}
                ></${ViraButton}>
                ${folder.parentRepoPath
                    ? html`
                          <${ViraButton.assign({
                              icon: lucideIcons.Trash2,
                              buttonSize: ViraSize.Small,
                              color: ViraColorVariant.Danger,
                          })}
                              title="Delete worktree"
                              ${listen('click', (event) => {
                                  event.stopPropagation();
                                  void confirmDeleteWorktree(folder.path, updateState);
                              })}
                          ></${ViraButton}>
                      `
                    : html`
                          <${ViraButton.assign({
                              icon: lucideIcons.X,
                              buttonSize: ViraSize.Small,
                              color: ViraColorVariant.Danger,
                          })}
                              title="Remove repo"
                              ${listen('click', (event) => {
                                  event.stopPropagation();
                                  void confirmRemoveRepo(folder.path, updateState);
                              })}
                          ></${ViraButton}>
                      `}
            </span>
        </div>
    `;
}

async function refresh(state: SidebarState, updateState: SidebarUpdate): Promise<void> {
    try {
        const folders = await getFolders();
        updateState({folders, loadError: undefined});
    } catch (error: unknown) {
        updateState({loadError: error instanceof Error ? error.message : String(error)});
    }
}

function showError(updateState: SidebarUpdate, error: unknown): void {
    updateState({loadError: error instanceof Error ? error.message : String(error)});
}

async function promptAddRepo(updateState: SidebarUpdate): Promise<void> {
    const input = window.prompt('Absolute path of the repo to add:');
    if (!input) {
        return;
    }
    try {
        const config = await getConfig();
        const path = input.trim();
        if (config.repos.some((repo) => repo.path === path)) {
            return;
        }
        await putConfig({
            ...config,
            repos: [
                ...config.repos,
                {
                    path,
                    postWorktreeCmd: null,
                },
            ],
        });
        await refresh({folders: [], pollHandle: undefined, loadError: undefined}, updateState);
    } catch (error: unknown) {
        showError(updateState, error);
    }
}

async function confirmRemoveRepo(repoPath: string, updateState: SidebarUpdate): Promise<void> {
    if (!window.confirm(`Remove repo ${repoPath}?`)) {
        return;
    }
    try {
        const config = await getConfig();
        await putConfig({
            ...config,
            repos: config.repos.filter((repo) => repo.path !== repoPath),
            hiddenAiPane: config.hiddenAiPane.filter((path) => path !== repoPath),
        });
        await refresh({folders: [], pollHandle: undefined, loadError: undefined}, updateState);
    } catch (error: unknown) {
        showError(updateState, error);
    }
}

async function promptAddWorktree(repoPath: string, updateState: SidebarUpdate): Promise<void> {
    const name = window.prompt(`Name for new worktree under ${repoPath}:`);
    if (!name) {
        return;
    }
    try {
        await createWorktree({repoPath, name: name.trim()});
        await refresh({folders: [], pollHandle: undefined, loadError: undefined}, updateState);
    } catch (error: unknown) {
        showError(updateState, error);
    }
}

async function confirmDeleteWorktree(
    worktreePath: string,
    updateState: SidebarUpdate,
): Promise<void> {
    if (!window.confirm(`Delete worktree ${worktreePath}?`)) {
        return;
    }
    try {
        await deleteWorktree({worktreePath});
        await refresh({folders: [], pollHandle: undefined, loadError: undefined}, updateState);
    } catch (error: unknown) {
        showError(updateState, error);
    }
}

async function toggleAiHidden(folderPath: string, updateState: SidebarUpdate): Promise<void> {
    try {
        const config = await getConfig();
        const isHidden = config.hiddenAiPane.includes(folderPath);
        await putConfig({
            ...config,
            hiddenAiPane: isHidden
                ? config.hiddenAiPane.filter((path) => path !== folderPath)
                : [
                      ...config.hiddenAiPane,
                      folderPath,
                  ],
        });
        await refresh({folders: [], pollHandle: undefined, loadError: undefined}, updateState);
    } catch (error: unknown) {
        showError(updateState, error);
    }
}
