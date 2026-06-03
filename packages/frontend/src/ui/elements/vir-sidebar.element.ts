import {
    type FolderInfo,
    PaneKind,
    PaneStatus,
    type RepoConfig,
    SidebarGrouping,
} from '@agent-storm/common';
import {check} from '@augment-vir/assert';
import {log} from '@augment-vir/common';
import {colorCss} from '@electrovir/color';
import {
    type AnyDuration,
    calculateRelativeDate,
    createUtcFullDate,
    getNowInUtcTimezone,
    isDateAfter,
} from 'date-vir';
import {css, defineElement, defineElementEvent, html, listen} from 'element-vir';
import {parseUrl} from 'url-vir';
import {
    createSizedIcon,
    HorizontalAnchor,
    LoaderAnimated24Icon,
    lucideIcons,
    renderMenuItemEntries,
    ViraButton,
    ViraColorVariant,
    ViraEmphasis,
    ViraIcon,
    ViraInput,
    ViraLink,
    type ViraMenuItemEntry,
    ViraMenuTrigger,
    ViraModal,
    ViraSize,
    viraThemeByKeys,
} from 'vira';
import {
    checkPath,
    createPath,
    createWorktree,
    deleteWorktree,
    getConfig,
    getFolders,
    killFolderPanes,
    putConfig,
    restartPane,
} from '../../util/api-client.js';
import {AgentStormMarkIcon} from '../icons/agent-storm-mark.icon.js';

const allowedLinkHostnames = ['github.com'];

const pollIntervalMs = 2000;

const loaderIcon = createSizedIcon(LoaderAnimated24Icon, 12);
const dashIcon = createSizedIcon(lucideIcons.Minus, 12);
const exitedIcon = createSizedIcon(lucideIcons.X, 12);
const mergedCheckIcon = createSizedIcon(lucideIcons.Check, 14);

const buttonIconSize = 16;
const plusIcon = createSizedIcon(lucideIcons.Plus, buttonIconSize);
const settingsIcon = createSizedIcon(lucideIcons.Settings, buttonIconSize);
const ellipsisIcon = createSizedIcon(lucideIcons.Ellipsis, buttonIconSize);
const filterIcon = createSizedIcon(lucideIcons.ListFilter, buttonIconSize);
const brandMarkIcon = createSizedIcon(AgentStormMarkIcon, 16);

const sidebarGroupingLabels: Record<SidebarGrouping, string> = {
    [SidebarGrouping.Repo]: 'Group by repo',
    [SidebarGrouping.Status]: 'Group by status',
};

const paneStatusColor: Record<PaneStatus, string> = {
    [PaneStatus.None]: String(viraThemeByKeys.grey.foreground.decoration.foreground.value),
    [PaneStatus.Busy]: String(viraThemeByKeys.pink.foreground.header.foreground.value),
    [PaneStatus.Idle]: String(viraThemeByKeys.grey.foreground.header.foreground.value),
    [PaneStatus.Exited]: String(viraThemeByKeys.red.foreground.header.foreground.value),
};

type SidebarState = {
    folders: ReadonlyArray<FolderInfo>;
    pollHandle: ReturnType<typeof setInterval> | undefined;
    loadError: string | undefined;
    openMenuKey: string | undefined;
    repoModalOpen: boolean;
    repoPath: string;
    repoAiCmd: string;
    repoGlobalAiCmd: string;
    repoSubmitting: boolean;
    worktreeModalRepoPath: string | undefined;
    worktreeName: string;
    worktreeAiCmd: string;
    worktreeGlobalAiCmd: string;
    worktreeSubmitting: boolean;
    /**
     * Mirrors `config.sidebarGrouping`. Fetched lazily on first refresh tick so the filter menu can
     * show which grouping is currently active (and so flipping it via the menu has a fresh value to
     * write back into config). `undefined` while we haven't loaded config yet.
     */
    sidebarGrouping: SidebarGrouping | undefined;
    /**
     * Mirrors `config.onlyShowRecent`. When true the sidebar hides standalone repos that lack
     * recent activity AND have no running panes; worktree-roots and their children are always
     * shown. `undefined` while config hasn't loaded yet, which renders the same as `false`.
     */
    onlyShowRecent: boolean | undefined;
    /**
     * Mirrors `config.repos`. Needed for the hide-inactive filter so we can look up each repo's
     * `lastInteractedAtMs` against the 7-day cutoff. Kept in lockstep with the folders list via
     * `refresh()`.
     */
    repos: ReadonlyArray<RepoConfig>;
};

type SidebarUpdate = (newState: Partial<SidebarState>) => void;

type PaneRestartedEvent = {
    folder: string;
    kind: PaneKind;
};

export const VirSidebar = defineElement<{
    activeFolder: string | undefined;
    hideBorder?: boolean | undefined;
    mobileModal?: boolean | undefined;
}>()({
    tagName: 'vir-sidebar',
    events: {
        /**
         * Emitted when the user clicks a folder row or when an internal action (e.g. creating a
         * worktree) wants to make the new folder the active one. Detail is the absolute folder
         * path. Parent owns the `activeFolder` / `openedFolders` state, so it listens for this and
         * updates accordingly.
         */
        folderActivated: defineElementEvent<string>(),
        /**
         * Emitted just after the user confirms a worktree-delete or repo-remove, before the API
         * trip starts. The detail carries every folder path that is now gone (the removed item
         * plus, for repo removal, all of its worktree children). The parent listens to clear
         * `activeFolder` if it pointed at one of them and drop them from `openedFolders` so the
         * right-hand pane unmounts immediately instead of waiting for the next folder-info poll.
         */
        foldersRemoved: defineElementEvent<ReadonlyArray<string>>(),
        /** Emitted after a pane restart succeeds so the mounted terminal can reconnect. */
        paneRestarted: defineElementEvent<PaneRestartedEvent>(),
        /** Emitted when the user clicks the gear button. Parent owns the modal open state. */
        openSettingsRequested: defineElementEvent<void>(),
    },
    state(): SidebarState {
        return {
            folders: [],
            pollHandle: undefined,
            loadError: undefined,
            openMenuKey: undefined,
            repoModalOpen: false,
            repoPath: '',
            repoAiCmd: '',
            repoGlobalAiCmd: '',
            repoSubmitting: false,
            worktreeModalRepoPath: undefined,
            worktreeName: '',
            worktreeAiCmd: '',
            worktreeGlobalAiCmd: '',
            worktreeSubmitting: false,
            sidebarGrouping: undefined,
            onlyShowRecent: undefined,
            repos: [],
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

        :host([data-hide-border]) {
            border-right: none;
        }

        :host([data-mobile-modal]) {
            width: 100%;
            font-size: 15px;
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
            display: inline-flex;
            align-items: center;
            gap: 6px;
            font-weight: 600;
            letter-spacing: 0.02em;
            color: ${viraThemeByKeys.grey.foreground.header.foreground.value};
            font-size: 13px;
        }

        .header-actions {
            display: flex;
            gap: 6px;
            align-items: center;
        }

        .list {
            flex-grow: 1;
            overflow-y: auto;
            padding: 4px 0 32px;
            /* Atkinson Hyperlegible Next — proportional sans designed for legibility (especially
               for low-vision readers). The rest of the sidebar (logo title, error banner, etc.)
               keeps the system sans-serif inherited from :host. */
            font-family: 'Atkinson Hyperlegible Next', ui-sans-serif, system-ui, sans-serif;
            font-size: 13px;
            font-weight: 300;
            letter-spacing: 0.01em;
        }

        .repo-header {
            padding: 6px 10px 2px;
            font-weight: 600;
            display: flex;
            justify-content: space-between;
            align-items: center;
            gap: 6px;
        }

        .row {
            display: flex;
            align-items: center;
            gap: 4px;
            padding: 0 10px;
            cursor: pointer;
            user-select: none;
        }

        .row .chips + .name {
            margin-left: -2px;
        }

        .row:hover {
            background-color: ${viraThemeByKeys.grey['behind-fg']['small-body'].background.value};
        }

        .row[data-active] {
            background-color: ${viraThemeByKeys.blue['behind-fg']['small-body'].background.value};
        }

        .row[data-indented] {
            padding-left: 22px;
        }

        .chips {
            display: inline-flex;
            gap: 0;
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
            overflow-wrap: anywhere;
            padding: 2px 0;
        }

        .name[data-pr-open] {
            text-decoration: underline;
            text-decoration-color: ${viraThemeByKeys.blue.foreground.body.foreground.value};
        }

        .name[data-pr-merged] {
            text-decoration: underline;
            text-decoration-color: ${viraThemeByKeys.purple.foreground.body.foreground.value};
        }

        .pr-merged-check {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 14px;
            height: 14px;
            color: ${viraThemeByKeys.green.foreground.header.foreground.value};
            flex-shrink: 0;
        }

        .actions {
            display: inline-flex;
            gap: 2px;
        }

        .row .actions {
            opacity: 0.35;
        }

        .repo-header .actions {
            opacity: 0;
        }

        .row:hover .actions,
        .row[data-menu-open] .actions,
        .repo-header:hover .actions,
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

        .repo-modal-body,
        .worktree-modal-body {
            display: flex;
            flex-direction: column;
            gap: 12px;
            width: min(520px, calc(100dvw - 48px));
            max-width: 100%;
            box-sizing: border-box;
        }

        .repo-modal-footer,
        .worktree-modal-footer {
            display: flex;
            justify-content: flex-end;
            gap: 8px;
        }

        .repo-modal-body ${ViraInput}, .worktree-modal-body ${ViraInput} {
            min-width: 0;
            width: 100%;
        }

        :host([data-mobile-modal]) .header {
            padding: 12px 16px;
        }

        :host([data-mobile-modal]) .title {
            font-size: 16px;
        }

        :host([data-mobile-modal]) .list {
            font-size: 16px;
        }

        :host([data-mobile-modal]) .repo-header {
            padding: 10px 16px 4px;
        }

        :host([data-mobile-modal]) .row {
            gap: 6px;
            min-height: 34px;
            padding: 4px 16px;
        }

        :host([data-mobile-modal]) .row[data-indented] {
            padding-left: 30px;
        }

        :host([data-mobile-modal]) .name {
            padding: 4px 0;
        }

        :host([data-mobile-modal]) .chip {
            width: 16px;
            height: 16px;
        }

        @media (max-width: 420px) {
            .repo-modal-body,
            .worktree-modal-body {
                width: calc(100dvw - 32px);
            }

            .repo-modal-footer,
            .worktree-modal-footer {
                justify-content: stretch;
            }

            .repo-modal-footer ${ViraButton}, .worktree-modal-footer ${ViraButton} {
                width: 100%;
            }
        }
    `,
    init({updateState}) {
        void refresh(updateState);
        const pollHandle = setInterval(() => {
            void refresh(updateState);
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
    render({inputs, state, updateState, host, dispatch, events}) {
        if (inputs.hideBorder) {
            host.setAttribute('data-hide-border', '');
        } else {
            host.removeAttribute('data-hide-border');
        }
        if (inputs.mobileModal) {
            host.setAttribute('data-mobile-modal', '');
        } else {
            host.removeAttribute('data-mobile-modal');
        }

        /**
         * Apply the hide-inactive filter once up front. Both the standalone list and the worktree
         * roots iterate the same pre-filtered array so a hidden repo's children disappear with it,
         * and the empty-state message below uses the filtered count to stay accurate.
         */
        const visibleFolders = state.onlyShowRecent
            ? filterByRecency(state.folders, state.repos)
            : state.folders;
        const standaloneFolders = visibleFolders
            .filter((folder) => !folder.isWorktreeRoot && !folder.parentRepoPath)
            .toSorted((a, b) =>
                a.name.localeCompare(b.name, undefined, {
                    sensitivity: 'base',
                }),
            );
        const worktreeRoots = visibleFolders.filter((folder) => folder.isWorktreeRoot);
        /**
         * Closes over `state.folders` from the latest render so the optimistic-delete handler can
         * filter against the freshest snapshot without having to ask for a re-read.
         */
        const removeFolderLocally = (path: string) => {
            updateState({
                folders: state.folders.filter((folder) => folder.path !== path),
            });
        };
        /**
         * Fire the `foldersRemoved` event so the parent can drop `activeFolder` / `openedFolders`
         * entries pointing at the gone folders. Used by the delete-worktree and remove-repo flows
         * after the user confirms but before the API trip.
         */
        const emitFoldersRemoved = (paths: ReadonlyArray<string>) => {
            dispatch(new events.foldersRemoved(paths));
        };
        const emitFolderActivated = (path: string) => {
            dispatch(new events.folderActivated(path));
        };
        const emitPaneRestarted = (detail: PaneRestartedEvent) => {
            dispatch(new events.paneRestarted(detail));
        };
        const closeRepoModal = () => {
            updateState({
                repoModalOpen: false,
                repoPath: '',
                repoAiCmd: '',
                repoGlobalAiCmd: '',
                repoSubmitting: false,
            });
        };
        const submitRepo = () => {
            void submitAddRepo({
                state,
                updateState,
                notifyActivated: emitFolderActivated,
            });
        };
        const closeWorktreeModal = () => {
            updateState({
                worktreeModalRepoPath: undefined,
                worktreeName: '',
                worktreeAiCmd: '',
                worktreeGlobalAiCmd: '',
                worktreeSubmitting: false,
            });
        };
        const submitWorktree = () => {
            void submitAddWorktree({
                state,
                updateState,
                onActivate: emitFolderActivated,
            });
        };

        return html`
            <div class="header">
                <span class="title">
                    <${ViraIcon.assign({
                        icon: brandMarkIcon,
                    })}></${ViraIcon}>
                    agent-storm
                </span>
                <span class="header-actions">
                    <${ViraButton.assign({
                        icon: plusIcon,
                        buttonSize: ViraSize.Small,
                        color: ViraColorVariant.Positive,
                    })}
                        title="Add new repository."
                        ${listen('click', () => void openAddRepoModal(updateState))}
                    ></${ViraButton}>
                    <${ViraMenuTrigger.assign({
                        horizontalAnchor: HorizontalAnchor.Right,
                    })}
                        ${listen(ViraMenuTrigger.events.openChange, (event) => {
                            updateState({
                                openMenuKey: event.detail ? 'sidebar-grouping' : undefined,
                            });
                        })}
                    >
                        <${ViraButton.assign({
                            icon: filterIcon,
                            buttonSize: ViraSize.Small,
                            buttonEmphasis: ViraEmphasis.Subtle,
                            color: ViraColorVariant.Neutral,
                        })}
                            slot=${ViraMenuTrigger.slotNames.trigger}
                            title="Filter & group sidebar"
                        ></${ViraButton}>
                        ${renderMenuItemEntries(
                            buildFilterMenuEntries({
                                sidebarGrouping: state.sidebarGrouping,
                                onlyShowRecent: state.onlyShowRecent,
                                updateState,
                            }),
                        )}
                    </${ViraMenuTrigger}>
                    <${ViraButton.assign({
                        icon: settingsIcon,
                        buttonSize: ViraSize.Small,
                        buttonEmphasis: ViraEmphasis.Subtle,
                        color: ViraColorVariant.Neutral,
                    })}
                        ${listen('click', () => dispatch(new events.openSettingsRequested()))}
                    ></${ViraButton}>
                </span>
            </div>
            ${state.loadError
                ? html`
                      <div class="error">${state.loadError}</div>
                  `
                : ''}
            <div class="list">
                ${visibleFolders.length === 0 && !state.loadError
                    ? html`
                          <div class="empty">
                              ${state.folders.length === 0
                                  ? 'No repos configured. Click + to add one.'
                                  : 'No recently active repos. Toggle Hide Inactive to show all.'}
                          </div>
                      `
                    : ''}
                ${standaloneFolders.map((folder) =>
                    renderRow({
                        folder,
                        indented: false,
                        activeFolder: inputs.activeFolder,
                        openMenuKey: state.openMenuKey,
                        onActivate: emitFolderActivated,
                        removeFolderLocally,
                        emitFoldersRemoved,
                        emitPaneRestarted,
                        updateState,
                    }),
                )}
                ${worktreeRoots.map((root) => {
                    const children = state.folders
                        .filter((folder) => folder.parentRepoPath === root.path)
                        .toSorted((a, b) =>
                            a.name.localeCompare(b.name, undefined, {
                                sensitivity: 'base',
                            }),
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
                                        icon: ellipsisIcon,
                                        buttonSize: ViraSize.Small,
                                        buttonEmphasis: ViraEmphasis.Subtle,
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
                                                void openAddWorktreeModal(root.path, updateState);
                                            },
                                        },
                                        {
                                            content: 'Remove repo',
                                            iconOverride: lucideIcons.X,
                                            onClick: () => {
                                                void confirmRemoveRepo(root.path, updateState, () =>
                                                    emitFoldersRemoved([
                                                        root.path,
                                                        ...children.map((child) => child.path),
                                                    ]),
                                                );
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
                                onActivate: emitFolderActivated,
                                removeFolderLocally,
                                emitFoldersRemoved,
                                emitPaneRestarted,
                                updateState,
                            }),
                        )}
                    `;
                })}
            </div>
            <${ViraModal.assign({
                open: state.repoModalOpen,
                modalTitle: 'New repo',
            })}
                ${listen(ViraModal.events.modalClose, closeRepoModal)}
            >
                <div class="repo-modal-body">
                    <${ViraInput.assign({
                        label: 'Repo path',
                        value: state.repoPath,
                        placeholder: '~/src/project',
                        showClearButton: true,
                        disabled: state.repoSubmitting,
                    })}
                        ${listen(ViraInput.events.valueChange, (event) => {
                            updateState({
                                repoPath: event.detail,
                            });
                        })}
                        ${listen('keydown', (event) => {
                            if (event instanceof KeyboardEvent && event.key === 'Enter') {
                                submitRepo();
                            }
                        })}
                    ></${ViraInput}>
                    <${ViraInput.assign({
                        label: 'AI command override',
                        value: state.repoAiCmd,
                        placeholder: state.repoGlobalAiCmd || 'claude',
                        showClearButton: true,
                        disabled: state.repoSubmitting,
                    })}
                        ${listen(ViraInput.events.valueChange, (event) => {
                            updateState({
                                repoAiCmd: event.detail,
                            });
                        })}
                        ${listen('keydown', (event) => {
                            if (event instanceof KeyboardEvent && event.key === 'Enter') {
                                submitRepo();
                            }
                        })}
                    ></${ViraInput}>
                    <div class="repo-modal-footer">
                        <${ViraButton.assign({
                            text: 'Cancel',
                            buttonEmphasis: ViraEmphasis.Subtle,
                            color: ViraColorVariant.Neutral,
                            isDisabled: state.repoSubmitting,
                        })}
                            ${listen('click', closeRepoModal)}
                        ></${ViraButton}>
                        <${ViraButton.assign({
                            text: 'Add',
                            color: ViraColorVariant.Brand,
                            isDisabled: !state.repoPath.trim() || state.repoSubmitting,
                        })}
                            ${listen('click', submitRepo)}
                        ></${ViraButton}>
                    </div>
                </div>
            </${ViraModal}>
            <${ViraModal.assign({
                open: !!state.worktreeModalRepoPath,
                modalTitle: 'New worktree',
            })}
                ${listen(ViraModal.events.modalClose, closeWorktreeModal)}
            >
                <div class="worktree-modal-body">
                    <${ViraInput.assign({
                        label: 'Worktree name',
                        value: state.worktreeName,
                        placeholder: 'branch-name',
                        showClearButton: true,
                        disabled: state.worktreeSubmitting,
                    })}
                        ${listen(ViraInput.events.valueChange, (event) => {
                            updateState({
                                worktreeName: event.detail,
                            });
                        })}
                        ${listen('keydown', (event) => {
                            if (event instanceof KeyboardEvent && event.key === 'Enter') {
                                submitWorktree();
                            }
                        })}
                    ></${ViraInput}>
                    <${ViraInput.assign({
                        label: 'AI command override',
                        value: state.worktreeAiCmd,
                        placeholder: state.worktreeGlobalAiCmd || 'claude',
                        showClearButton: true,
                        disabled: state.worktreeSubmitting,
                    })}
                        ${listen(ViraInput.events.valueChange, (event) => {
                            updateState({
                                worktreeAiCmd: event.detail,
                            });
                        })}
                        ${listen('keydown', (event) => {
                            if (event instanceof KeyboardEvent && event.key === 'Enter') {
                                submitWorktree();
                            }
                        })}
                    ></${ViraInput}>
                    <div class="worktree-modal-footer">
                        <${ViraButton.assign({
                            text: 'Cancel',
                            buttonEmphasis: ViraEmphasis.Subtle,
                            color: ViraColorVariant.Neutral,
                            isDisabled: state.worktreeSubmitting,
                        })}
                            ${listen('click', closeWorktreeModal)}
                        ></${ViraButton}>
                        <${ViraButton.assign({
                            text: 'Create',
                            color: ViraColorVariant.Brand,
                            isDisabled: !state.worktreeName.trim() || state.worktreeSubmitting,
                        })}
                            ${listen('click', submitWorktree)}
                        ></${ViraButton}>
                    </div>
                </div>
            </${ViraModal}>
        `;
    },
});

function renderPaneChip(label: string, status: PaneStatus) {
    if (status === PaneStatus.None) {
        return html`
            <span class="chip" title="${label} pane: ${status}"></span>
        `;
    }
    const icon =
        status === PaneStatus.Busy
            ? loaderIcon
            : status === PaneStatus.Exited
              ? exitedIcon
              : dashIcon;
    return html`
        <span
            class="chip"
            style="color: ${paneStatusColor[status]};"
            title="${label} pane: ${status}"
        >
            <${ViraIcon.assign({
                icon,
            })}></${ViraIcon}>
        </span>
    `;
}

function renderRow({
    folder,
    indented,
    activeFolder,
    openMenuKey,
    onActivate,
    removeFolderLocally,
    emitFoldersRemoved,
    emitPaneRestarted,
    updateState,
}: Readonly<{
    folder: FolderInfo;
    indented: boolean;
    activeFolder: string | undefined;
    openMenuKey: string | undefined;
    onActivate: (folder: string) => void;
    removeFolderLocally: (path: string) => void;
    emitFoldersRemoved: (paths: ReadonlyArray<string>) => void;
    emitPaneRestarted: (detail: PaneRestartedEvent) => void;
    updateState: SidebarUpdate;
}>) {
    const nameWithMarkers = [
        folder.name,
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
                ${nameWithMarkers}
            </span>
            ${folder.prMerged
                ? html`
                      <span class="pr-merged-check" title="PR merged">
                          <${ViraIcon.assign({
                              icon: mergedCheckIcon,
                          })}></${ViraIcon}>
                      </span>
                  `
                : ''}
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
                        icon: ellipsisIcon,
                        buttonSize: ViraSize.Small,
                        buttonEmphasis: ViraEmphasis.Subtle,
                        color: ViraColorVariant.Neutral,
                    })}
                        slot=${ViraMenuTrigger.slotNames.trigger}
                        title="Folder actions"
                    ></${ViraButton}>
                    ${renderMenuItemEntries(
                        buildRowMenuEntries(
                            folder,
                            updateState,
                            removeFolderLocally,
                            emitFoldersRemoved,
                            emitPaneRestarted,
                        ),
                    )}
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

function buildFilterMenuEntries({
    sidebarGrouping,
    onlyShowRecent,
    updateState,
}: Readonly<{
    sidebarGrouping: SidebarGrouping | undefined;
    onlyShowRecent: boolean | undefined;
    updateState: SidebarUpdate;
}>): ReadonlyArray<ViraMenuItemEntry> {
    const groupingEntries: ReadonlyArray<ViraMenuItemEntry> = [
        SidebarGrouping.Repo,
        SidebarGrouping.Status,
    ].map((grouping) => ({
        content: sidebarGroupingLabels[grouping],
        /**
         * Mark the active grouping with a check; non-active entries get no icon. `iconOverride` is
         * the menu's per-item icon slot — leaving it undefined leaves blank space, which keeps the
         * labels visually aligned across rows.
         */
        iconOverride: sidebarGrouping === grouping ? lucideIcons.Check : undefined,
        onClick: () => {
            if (sidebarGrouping === grouping) {
                return;
            }
            void setSidebarGrouping(grouping, updateState);
        },
    }));
    return [
        ...groupingEntries,
        {
            content: 'Hide Inactive',
            /**
             * Click toggles the persisted `onlyShowRecent` flag. A check icon shows the current
             * state — the user can flip it off the same way they turned it on.
             */
            iconOverride: onlyShowRecent ? lucideIcons.Check : undefined,
            onClick: () => {
                void toggleHideInactive(!onlyShowRecent, updateState);
            },
        },
    ];
}

function buildRowMenuEntries(
    folder: FolderInfo,
    updateState: SidebarUpdate,
    removeFolderLocally: (path: string) => void,
    emitFoldersRemoved: (paths: ReadonlyArray<string>) => void,
    emitPaneRestarted: (detail: PaneRestartedEvent) => void,
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
                void (async () => {
                    try {
                        await restartPane({
                            folder: folder.path,
                            kind: PaneKind.Ai,
                        });
                        emitPaneRestarted({
                            folder: folder.path,
                            kind: PaneKind.Ai,
                        });
                    } catch (error: unknown) {
                        showError(updateState, error);
                    }
                })();
            },
        },
        {
            content: 'Replace AI command',
            iconOverride: lucideIcons.Terminal,
            onClick: () => {
                void promptReplaceAiCommand({
                    folder,
                    updateState,
                    emitPaneRestarted,
                });
            },
        },
        {
            content: 'Kill folder panes',
            iconOverride: lucideIcons.PowerOff,
            onClick: () => {
                void (async () => {
                    try {
                        await killFolderPanes({
                            folder: folder.path,
                        });
                        /**
                         * After a successful kill, treat the folder as no-longer-opened: drop it
                         * from `vir-app`'s `openedFolders` (which unmounts its pane group and
                         * disposes the terminals) and clear the route if it was the active one.
                         * Reusing the `foldersRemoved` event is intentional — vir-app's handler
                         * does exactly the openedFolders + route teardown we want, without touching
                         * the sidebar's own folders list (the row stays visible). Next click on the
                         * same row re-adds it to `openedFolders`, which remounts `VirPaneGroup` /
                         * `VirTerminal` and triggers a fresh `/pty` attach so the backend spawns
                         * new PTYs.
                         */
                        emitFoldersRemoved([folder.path]);
                    } catch (error: unknown) {
                        showError(updateState, error);
                    }
                })();
            },
        },
        folder.parentRepoPath
            ? {
                  content: 'Delete worktree',
                  iconOverride: lucideIcons.Trash2,
                  onClick: () => {
                      void confirmDeleteWorktree(
                          folder.path,
                          updateState,
                          removeFolderLocally,
                          () => emitFoldersRemoved([folder.path]),
                      );
                  },
              }
            : {
                  content: 'Remove repo',
                  iconOverride: lucideIcons.X,
                  onClick: () => {
                      void confirmRemoveRepo(folder.path, updateState, () =>
                          emitFoldersRemoved([folder.path]),
                      );
                  },
              },
    ].filter(check.isTruthy);
}

/**
 * Worktrees the user has asked to delete that the backend is still processing. The 2s sidebar poll
 * fetches `/folders` while `git worktree remove --force` + `refreshFolderInfoNow` are still in
 * flight, so without this filter the deleted row would pop back in until the backend's response
 * lands. Entries clear in `confirmDeleteWorktree`'s `finally` once the delete settles (success or
 * failure).
 */
const pendingWorktreeDeletions = new Set<string>();

async function refresh(updateState: SidebarUpdate): Promise<void> {
    try {
        /**
         * Fetch folders + config in parallel. Config tells us the current `sidebarGrouping` so the
         * filter menu can mark the active choice; folders feeds the list.
         */
        const [
            folders,
            config,
        ] = await Promise.all([
            getFolders(),
            getConfig(),
        ]);
        updateState({
            folders: pendingWorktreeDeletions.size
                ? folders.filter((folder) => !pendingWorktreeDeletions.has(folder.path))
                : folders,
            loadError: undefined,
            sidebarGrouping: config.sidebarGrouping,
            onlyShowRecent: config.onlyShowRecent,
            repos: config.repos,
        });
    } catch (error: unknown) {
        updateState({
            loadError: error instanceof Error ? error.message : String(error),
        });
    }
}

async function setSidebarGrouping(
    grouping: SidebarGrouping,
    updateState: SidebarUpdate,
): Promise<void> {
    try {
        const config = await getConfig();
        await putConfig({
            ...config,
            sidebarGrouping: grouping,
        });
        updateState({
            sidebarGrouping: grouping,
        });
    } catch (error: unknown) {
        showError(updateState, error);
    }
}

async function toggleHideInactive(nextValue: boolean, updateState: SidebarUpdate): Promise<void> {
    try {
        const config = await getConfig();
        await putConfig({
            ...config,
            onlyShowRecent: nextValue,
        });
        updateState({
            onlyShowRecent: nextValue,
        });
    } catch (error: unknown) {
        showError(updateState, error);
    }
}

/**
 * Window for "recent" activity used by the hide-inactive filter. Anything older than this (or
 * missing a timestamp entirely) counts as inactive when `onlyShowRecent` is on. Standalone repos
 * with no recent timestamp can still appear if they have a running AI/shell pane.
 */
const recencyWindow: AnyDuration = {
    days: -7,
};

function isPaneRunning(status: PaneStatus): boolean {
    return status === PaneStatus.Busy || status === PaneStatus.Idle;
}

/**
 * Filters folders according to the "Hide Inactive" rule:
 *
 * - Worktree-roots and their children are always shown (per the user's request — worktrees aren't
 *   gated by recency).
 * - Standalone repos are shown only if their `lastInteractedAtMs` is within the last 7 days OR they
 *   currently have a running pane (Busy/Idle on AI or shell), so an actively-running but
 *   never-touched repo still appears.
 */
function filterByRecency(
    folders: ReadonlyArray<FolderInfo>,
    repos: ReadonlyArray<RepoConfig>,
): FolderInfo[] {
    const cutoff = calculateRelativeDate(getNowInUtcTimezone(), recencyWindow);
    const recentRepoPaths = new Set(
        repos
            .filter(
                (repo) =>
                    repo.lastInteractedAtMs != undefined &&
                    isDateAfter({
                        fullDate: createUtcFullDate(repo.lastInteractedAtMs),
                        relativeTo: cutoff,
                    }),
            )
            .map((repo) => repo.path),
    );
    return folders.filter(
        (folder) =>
            folder.isWorktreeRoot ||
            !!folder.parentRepoPath ||
            recentRepoPaths.has(folder.path) ||
            isPaneRunning(folder.panes.ai) ||
            isPaneRunning(folder.panes.shell),
    );
}

async function promptReplaceAiCommand({
    folder,
    updateState,
    emitPaneRestarted,
}: Readonly<{
    folder: FolderInfo;
    updateState: SidebarUpdate;
    emitPaneRestarted: (detail: PaneRestartedEvent) => void;
}>): Promise<void> {
    try {
        const config = await getConfig();
        const input = window.prompt(`AI command for ${folder.path}:`, folder.aiCmd || config.aiCmd);
        if (input == undefined) {
            return;
        }
        const aiCmd = input.trim();
        if (!aiCmd) {
            showError(updateState, 'AI command cannot be empty.');
            return;
        }
        await putConfig({
            ...config,
            folderAiCmds:
                aiCmd === config.aiCmd
                    ? config.folderAiCmds.filter((entry) => entry.folder !== folder.path)
                    : [
                          ...config.folderAiCmds.filter((entry) => entry.folder !== folder.path),
                          {
                              folder: folder.path,
                              aiCmd,
                          },
                      ],
        });
        await restartPane({
            folder: folder.path,
            kind: PaneKind.Ai,
        });
        emitPaneRestarted({
            folder: folder.path,
            kind: PaneKind.Ai,
        });
        await refresh(updateState);
    } catch (error: unknown) {
        showError(updateState, error);
    }
}

function showError(updateState: SidebarUpdate, error: unknown): void {
    updateState({
        loadError: error instanceof Error ? error.message : String(error),
    });
}

async function openAddRepoModal(updateState: SidebarUpdate): Promise<void> {
    try {
        const config = await getConfig();
        updateState({
            repoModalOpen: true,
            repoPath: '',
            repoAiCmd: '',
            repoGlobalAiCmd: config.aiCmd,
            repoSubmitting: false,
        });
    } catch (error: unknown) {
        showError(updateState, error);
    }
}

async function submitAddRepo({
    state,
    updateState,
    notifyActivated,
}: Readonly<{
    state: SidebarState;
    updateState: SidebarUpdate;
    notifyActivated: (path: string) => void;
}>): Promise<void> {
    const input = state.repoPath.trim();
    if (!input) {
        return;
    }
    try {
        updateState({
            repoSubmitting: true,
        });
        /**
         * Resolve the user's input on the server (handles `~` expansion + `path.resolve`) so we can
         * branch on existence using a stable, absolute path. Missing paths still require explicit
         * confirmation before creation so a typo in this modal does not create directories
         * silently.
         */
        const initial = await checkPath({
            path: input,
        });
        const path = initial.resolvedPath;
        if (!initial.exists) {
            if (!window.confirm(`Path does not exist:\n\n${path}\n\nCreate it?`)) {
                updateState({
                    repoSubmitting: false,
                });
                return;
            }
            await createPath({
                path,
            });
        }
        const config = await getConfig();
        if (config.repos.some((repo) => repo.path === path)) {
            /** Repo already configured — activate the existing entry instead of no-oping. */
            updateState({
                repoModalOpen: false,
                repoPath: '',
                repoAiCmd: '',
                repoGlobalAiCmd: '',
                repoSubmitting: false,
            });
            notifyActivated(path);
            return;
        }
        const aiCmd = state.repoAiCmd.trim();
        await putConfig({
            ...config,
            repos: [
                ...config.repos,
                {
                    path,
                    postWorktreeCmd: null,
                },
            ],
            folderAiCmds:
                aiCmd && aiCmd !== config.aiCmd
                    ? [
                          ...config.folderAiCmds.filter((entry) => entry.folder !== path),
                          {
                              folder: path,
                              aiCmd,
                          },
                      ]
                    : config.folderAiCmds.filter((entry) => entry.folder !== path),
        });
        /**
         * Fetch the new folder list directly so we can find the repo's resolved path (may include a
         * worktree-root vs. standalone-repo entry) and activate it. The backend's `PUT /config`
         * already triggered `refreshFolderInfoNow`, so the targets are present by the time this GET
         * returns.
         */
        const folders = await getFolders();
        updateState({
            folders: pendingWorktreeDeletions.size
                ? folders.filter((folder) => !pendingWorktreeDeletions.has(folder.path))
                : folders,
            loadError: undefined,
            repoModalOpen: false,
            repoPath: '',
            repoAiCmd: '',
            repoGlobalAiCmd: '',
            repoSubmitting: false,
        });
        const newFolder = folders.find((folder) => folder.path === path);
        if (newFolder) {
            notifyActivated(activationTargetFor(newFolder, folders).path);
        }
    } catch (error: unknown) {
        updateState({
            repoSubmitting: false,
        });
        showError(updateState, error);
    }
}

/**
 * Resolve which folder should actually be activated when the user "selects" the given one. For
 * standalone repos the answer is just the folder itself; for worktree-roots the single-segment URL
 * `/<repoName>` is invalid per the router spec (vir-app's `resolveRoute` redirects it to `/`), so
 * we pick the first worktree child as the activation target instead. Falls back to the root if no
 * children exist yet (shouldn't happen — a worktree-root by definition has at least one child).
 */
function activationTargetFor(folder: FolderInfo, folders: ReadonlyArray<FolderInfo>): FolderInfo {
    if (!folder.isWorktreeRoot) {
        return folder;
    }
    const firstWorktree = folders.find((other) => other.parentRepoPath === folder.path);
    return firstWorktree ?? folder;
}

async function confirmRemoveRepo(
    repoPath: string,
    updateState: SidebarUpdate,
    notifyRemoved: () => void,
): Promise<void> {
    if (!window.confirm(`Remove repo ${repoPath}?`)) {
        return;
    }
    /**
     * Clear app-level selection / opened panes for this repo (and its worktrees) before the API
     * trip so the right pane unmounts immediately instead of waiting for the next folder-info
     * poll.
     */
    notifyRemoved();
    try {
        const config = await getConfig();
        await putConfig({
            ...config,
            repos: config.repos.filter((repo) => repo.path !== repoPath),
            hiddenAiPane: config.hiddenAiPane.filter((path) => path !== repoPath),
        });
        await refresh(updateState);
    } catch (error: unknown) {
        showError(updateState, error);
    }
}

async function openAddWorktreeModal(repoPath: string, updateState: SidebarUpdate): Promise<void> {
    try {
        const config = await getConfig();
        updateState({
            worktreeModalRepoPath: repoPath,
            worktreeName: '',
            worktreeAiCmd: '',
            worktreeGlobalAiCmd: config.aiCmd,
            worktreeSubmitting: false,
        });
    } catch (error: unknown) {
        showError(updateState, error);
    }
}

async function submitAddWorktree({
    state,
    updateState,
    onActivate,
}: Readonly<{
    state: SidebarState;
    updateState: SidebarUpdate;
    onActivate: (folder: string) => void;
}>): Promise<void> {
    const repoPath = state.worktreeModalRepoPath;
    const trimmedName = state.worktreeName.trim();
    if (!repoPath || !trimmedName || state.worktreeSubmitting) {
        return;
    }
    const aiCmd = state.worktreeAiCmd.trim();
    try {
        updateState({
            worktreeSubmitting: true,
        });
        await createWorktree({
            repoPath,
            name: trimmedName,
            aiCmd: aiCmd && aiCmd !== state.worktreeGlobalAiCmd ? aiCmd : undefined,
        });
        const folders = await getFolders();
        updateState({
            folders,
            loadError: undefined,
            worktreeModalRepoPath: undefined,
            worktreeName: '',
            worktreeAiCmd: '',
            worktreeGlobalAiCmd: '',
            worktreeSubmitting: false,
        });
        const newWorktree = folders.find(
            (folder) => folder.parentRepoPath === repoPath && folder.name === trimmedName,
        );
        if (newWorktree) {
            onActivate(newWorktree.path);
        }
    } catch (error: unknown) {
        updateState({
            worktreeSubmitting: false,
        });
        showError(updateState, error);
    }
}

async function confirmDeleteWorktree(
    worktreePath: string,
    updateState: SidebarUpdate,
    removeFolderLocally: (path: string) => void,
    notifyRemoved: () => void,
): Promise<void> {
    if (!window.confirm(`Delete worktree ${worktreePath}?`)) {
        return;
    }
    /**
     * Optimistically drop the row from the sidebar before the API trip. `git worktree remove
     * --force` plus the subsequent `refreshFolderInfoNow` can take a couple of seconds; without
     * this the row sits stale until the response lands. Adding to `pendingWorktreeDeletions` keeps
     * the 2s background poll from un-removing it while the backend is still chewing through the
     * delete. `notifyRemoved` lets the parent clear `activeFolder` / `openedFolders` entries for
     * this worktree so the right-hand pane unmounts immediately. If the backend rejects the delete
     * the `catch` below re-fetches and the row reappears.
     */
    removeFolderLocally(worktreePath);
    notifyRemoved();
    pendingWorktreeDeletions.add(worktreePath);
    try {
        await deleteWorktree({
            worktreePath,
        });
    } catch (error: unknown) {
        showError(updateState, error);
    } finally {
        pendingWorktreeDeletions.delete(worktreePath);
        await refresh(updateState);
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
        await refresh(updateState);
    } catch (error: unknown) {
        showError(updateState, error);
    }
}
