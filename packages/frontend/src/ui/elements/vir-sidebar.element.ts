import {type FolderInfo, PaneKind, PaneStatus} from '@agent-storm/common';
import {check} from '@augment-vir/assert';
import {log} from '@augment-vir/common';
import {colorCss} from '@electrovir/color';
import {css, defineElement, html, listen} from 'element-vir';
import {parseUrl} from 'url-vir';
import {
    createSizedIcon,
    HorizontalAnchor,
    LoaderAnimated24Icon,
    lucideIcons,
    renderMenuItemEntries,
    ViraButton,
    ViraColorVariant,
    ViraIcon,
    ViraLink,
    type ViraMenuItemEntry,
    ViraMenuTrigger,
    ViraSize,
    viraThemeByKeys,
} from 'vira';
import {
    createWorktree,
    deleteWorktree,
    getConfig,
    getFolders,
    killFolderPanes,
    putConfig,
    restartPane,
} from '../../util/api-client.js';

const allowedLinkHostnames = ['github.com'];

const pollIntervalMs = 2000;

const loaderIcon = createSizedIcon(LoaderAnimated24Icon, 12);
const dashIcon = createSizedIcon(lucideIcons.Minus, 12);

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
    openMenuKey: string | undefined;
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
            openMenuKey: undefined,
        };
    },
    styles: css`
        :host {
            display: flex;
            flex-direction: column;
            height: 100%;
            font-family: ui-sans-serif, system-ui, sans-serif;
            font-size: 12px;
            border-right: 1px solid ${viraThemeByKeys.grey['behind-bg'].decoration.background.value};
            overflow: hidden;
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
        }

        .chip {
            width: 12px;
            height: 12px;
            display: inline-flex;
            align-items: center;
            justify-content: center;
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
        .repo-header:hover .actions,
        .row[data-menu-open] .actions,
        .repo-header[data-menu-open] .actions {
            opacity: 1;
        }

        .error {
            padding: 8px 10px;
            ${colorCss(viraThemeByKeys.red['behind-bg'].body)};
            border-bottom: 1px solid ${viraThemeByKeys.red['behind-bg'].decoration.background.value};
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
        updateState({
            pollHandle,
        });
    },
    cleanup({state}) {
        if (state.pollHandle) {
            clearInterval(state.pollHandle);
        }
    },
    render({inputs, state, updateState}) {
        const standaloneFolders = state.folders.filter(
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
                ${standaloneFolders.map((folder) =>
                    renderRow({
                        folder,
                        indented: false,
                        activeFolder: inputs.activeFolder,
                        openMenuKey: state.openMenuKey,
                        onActivate: inputs.onActivate,
                        updateState,
                    }),
                )}
                ${worktreeRoots.map((root) => {
                    const children = state.folders
                        .filter((folder) => folder.parentRepoPath === root.path)
                        .toSorted((a, b) =>
                            a.name.localeCompare(b.name, undefined, {sensitivity: 'base'}),
                        );
                    const repoMenuKey = `repo:${root.path}`;
                    return html`
                        <div
                            class="repo-header"
                            ?data-menu-open=${state.openMenuKey === repoMenuKey}
                        >
                            <span>${root.name}</span>
                            <span class="actions">
                                <${ViraMenuTrigger.assign({
                                    horizontalAnchor: HorizontalAnchor.Right,
                                })}
                                    ${listen(ViraMenuTrigger.events.openChange, (event) => {
                                        updateState({
                                            openMenuKey: event.detail ? repoMenuKey : undefined,
                                        });
                                    })}
                                >
                                    <${ViraButton.assign({
                                        icon: lucideIcons.EllipsisVertical,
                                        buttonSize: ViraSize.Small,
                                        color: ViraColorVariant.Neutral,
                                    })}
                                        slot=${ViraMenuTrigger.slotNames.trigger}
                                        title="Repo actions"
                                    ></${ViraButton}>
                                    ${renderMenuItemEntries([
                                        {
                                            content: 'Add worktree',
                                            iconOverride: lucideIcons.GitBranchPlus,
                                            onClick: () => {
                                                void promptAddWorktree(root.path, updateState);
                                            },
                                        },
                                        {
                                            content: 'Remove repo',
                                            iconOverride: lucideIcons.X,
                                            onClick: () => {
                                                void confirmRemoveRepo(root.path, updateState);
                                            },
                                        },
                                    ])}
                                </${ViraMenuTrigger}>
                            </span>
                        </div>
                        ${children.map((child) =>
                            renderRow({
                                folder: child,
                                indented: true,
                                activeFolder: inputs.activeFolder,
                                openMenuKey: state.openMenuKey,
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

function renderPaneChip(label: string, status: PaneStatus) {
    if (status === PaneStatus.None) {
        return html`
            <span class="chip" title="${label} pane: ${status}"></span>
        `;
    }
    const icon = status === PaneStatus.Busy ? loaderIcon : dashIcon;
    return html`
        <span
            class="chip"
            style="color: ${paneStatusColor[status]};"
            title="${label} pane: ${status}"
        >
            <${ViraIcon.assign({icon})}></${ViraIcon}>
        </span>
    `;
}

function renderRow({
    folder,
    indented,
    activeFolder,
    openMenuKey,
    onActivate,
    updateState,
}: Readonly<{
    folder: FolderInfo;
    indented: boolean;
    activeFolder: string | undefined;
    openMenuKey: string | undefined;
    onActivate: (folder: string) => void;
    updateState: SidebarUpdate;
}>) {
    const markers = [
        folder.git.dirty ? '*' : '',
        folder.git.notPushed ? '+' : '',
    ].join('');
    const rowMenuKey = `row:${folder.path}`;
    return html`
        <div
            class="row"
            ?data-active=${activeFolder === folder.path}
            ?data-indented=${indented}
            ?data-menu-open=${openMenuKey === rowMenuKey}
            ${listen('click', () => onActivate(folder.path))}
        >
            <span class="chips">
                ${renderPaneChip('AI', folder.panes.ai)}
                ${renderPaneChip('Shell', folder.panes.shell)}
            </span>
            <span
                class="name"
                ?data-pr-open=${!!folder.prUrl && !folder.prMerged}
                ?data-pr-merged=${!!folder.prUrl && folder.prMerged}
            >
                ${folder.name}
            </span>
            <span class="markers">${markers}</span>
            <span class="actions" ${listen('click', (event) => event.stopPropagation())}>
                <${ViraMenuTrigger.assign({
                    horizontalAnchor: HorizontalAnchor.Right,
                })}
                    ${listen(ViraMenuTrigger.events.openChange, (event) => {
                        updateState({
                            openMenuKey: event.detail ? rowMenuKey : undefined,
                        });
                    })}
                >
                    <${ViraButton.assign({
                        icon: lucideIcons.EllipsisVertical,
                        buttonSize: ViraSize.Small,
                        color: ViraColorVariant.Neutral,
                    })}
                        slot=${ViraMenuTrigger.slotNames.trigger}
                        title="Folder actions"
                    ></${ViraButton}>
                    ${renderMenuItemEntries(buildRowMenuEntries(folder, updateState))}
                </${ViraMenuTrigger}>
            </span>
        </div>
    `;
}

function isValidPrUrl(url: string | null | undefined): boolean {
    if (!url) {
        return false;
    }

    const parsed = parseUrl(url);
    const isHttp = parsed.protocol === 'https' || parsed.protocol === 'http';

    if (!isHttp) {
        log.error(`Cannot open non http URL: '${url}'`);
        return false;
    } else if (allowedLinkHostnames.includes(parsed.hostname)) {
        return true;
    } else {
        log.error(`Cannot open non approved host name: '${url}'`);
        return false;
    }
}

function buildRowMenuEntries(
    folder: FolderInfo,
    updateState: SidebarUpdate,
): ReadonlyArray<ViraMenuItemEntry> {
    return [
        folder.prUrl &&
            isValidPrUrl(folder.prUrl) && {
                content: html`
                    <${ViraLink.assign({
                        link: {
                            url: folder.prUrl,
                            newTab: true,
                        },
                        disableLinkStyles: true,
                    })}>
                        Open PR
                    </${ViraLink}>
                `,
                iconOverride: lucideIcons.ExternalLink,
            },
        {
            content: folder.aiHidden ? 'Show AI pane' : 'Hide AI pane',
            iconOverride: folder.aiHidden ? lucideIcons.Eye : lucideIcons.EyeOff,
            onClick: () => {
                void toggleAiHidden(folder.path, updateState);
            },
        },
        {
            content: 'Restart AI',
            iconOverride: lucideIcons.RotateCw,
            onClick: () => {
                void restartPane({
                    folder: folder.path,
                    kind: PaneKind.Ai,
                }).catch((error: unknown) => showError(updateState, error));
            },
        },
        {
            content: 'Kill folder panes',
            iconOverride: lucideIcons.PowerOff,
            onClick: () => {
                void killFolderPanes({
                    folder: folder.path,
                }).catch((error: unknown) => showError(updateState, error));
            },
        },
        folder.parentRepoPath
            ? {
                  content: 'Delete worktree',
                  iconOverride: lucideIcons.Trash2,
                  onClick: () => {
                      void confirmDeleteWorktree(folder.path, updateState);
                  },
              }
            : {
                  content: 'Remove repo',
                  iconOverride: lucideIcons.X,
                  onClick: () => {
                      void confirmRemoveRepo(folder.path, updateState);
                  },
              },
    ].filter(check.isTruthy);
}

async function refresh(state: SidebarState, updateState: SidebarUpdate): Promise<void> {
    try {
        const folders = await getFolders();
        updateState({
            folders,
            loadError: undefined,
        });
    } catch (error: unknown) {
        updateState({
            loadError: error instanceof Error ? error.message : String(error),
        });
    }
}

function showError(updateState: SidebarUpdate, error: unknown): void {
    updateState({
        loadError: error instanceof Error ? error.message : String(error),
    });
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
        await refresh(
            {
                folders: [],
                pollHandle: undefined,
                loadError: undefined,
                openMenuKey: undefined,
            },
            updateState,
        );
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
        await refresh(
            {
                folders: [],
                pollHandle: undefined,
                loadError: undefined,
                openMenuKey: undefined,
            },
            updateState,
        );
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
        await createWorktree({
            repoPath,
            name: name.trim(),
        });
        await refresh(
            {
                folders: [],
                pollHandle: undefined,
                loadError: undefined,
                openMenuKey: undefined,
            },
            updateState,
        );
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
        await deleteWorktree({
            worktreePath,
        });
        await refresh(
            {
                folders: [],
                pollHandle: undefined,
                loadError: undefined,
                openMenuKey: undefined,
            },
            updateState,
        );
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
        await refresh(
            {
                folders: [],
                pollHandle: undefined,
                loadError: undefined,
                openMenuKey: undefined,
            },
            updateState,
        );
    } catch (error: unknown) {
        showError(updateState, error);
    }
}
