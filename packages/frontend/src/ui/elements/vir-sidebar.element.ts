// cspell:words Hyperlegible, upserted

import {
    type AiDefinition,
    type FolderInfo,
    PaneKind,
    PaneStatus,
    type RepoConfig,
    SidebarGrouping,
    SidebarSorting,
    type UpdateStatus,
} from '@agent-storm/common';
import {check} from '@augment-vir/assert';
import {awaitedForEach, filterMap, getObjectTypedValues, log} from '@augment-vir/common';
import {colorCss} from '@electrovir/color';
import {
    type AnyDuration,
    calculateRelativeDate,
    createUtcFullDate,
    getNowInUtcTimezone,
    isDateAfter,
    toTimestamp,
} from 'date-vir';
import {css, defineElement, defineElementEvent, html, listen} from 'element-vir';
import {parseUrl} from 'url-vir';
import {
    createSizedIcon,
    HorizontalAnchor,
    LoaderAnimated24Icon,
    lucideIcons,
    type PopUpManager,
    renderMenuItemEntries,
    ViraButton,
    ViraColorVariant,
    ViraEmphasis,
    viraFormCssVars,
    ViraIcon,
    ViraInput,
    ViraLink,
    type ViraMenuItemEntry,
    ViraMenuTrigger,
    ViraModal,
    ViraPopUpTrigger,
    ViraSelect,
    type ViraSelectOption,
    viraShadows,
    ViraSize,
    viraThemeByKeys,
    type ViraThemeClient,
    ViraThemeSwitcher,
} from 'vira';
import {
    checkPath,
    createPath,
    createWorktree,
    deleteWorktree,
    getConfig,
    getFolders,
    getFolderSessions,
    getUpdateStatus,
    hideRepo,
    killFolderPanes,
    putConfig,
    restartPane,
    touchRepo,
} from '../../util/api-client.js';
import {reportRenderError} from '../../util/client-error-log.js';
import {AgentStormMarkIcon} from '../icons/agent-storm-mark.icon.js';
import {VirAiPickerModal} from './vir-ai-picker-modal.element.js';

const allowedLinkHostnames = ['github.com'];

const pollIntervalMs = 2000;

const loaderIcon = createSizedIcon(LoaderAnimated24Icon, 12);
const dashIcon = createSizedIcon(lucideIcons.Minus, 12);
const exitedIcon = createSizedIcon(lucideIcons.X, 12);
const mergedCheckIcon = createSizedIcon(lucideIcons.Check, 14);

const buttonIconSize = 16;
const searchIcon = createSizedIcon(lucideIcons.Search, buttonIconSize);
const plusIcon = createSizedIcon(lucideIcons.Plus, buttonIconSize);
const ellipsisIcon = createSizedIcon(lucideIcons.Ellipsis, buttonIconSize);
const filterIcon = createSizedIcon(lucideIcons.ListFilter, buttonIconSize);
const brandMarkIcon = createSizedIcon(AgentStormMarkIcon, 16);

/**
 * Larger icon variants for the mobile sidebar modal's header buttons. Paired with `ViraSize.Large`
 * so the tap targets land near Apple's HIG-recommended 44px, which the previous `ViraSize.Small` +
 * 16px-icon combo (24px tall) was well short of.
 */
const mobileButtonIconSize = 24;
const mobileSearchIcon = createSizedIcon(lucideIcons.Search, mobileButtonIconSize);
const mobilePlusIcon = createSizedIcon(lucideIcons.Plus, mobileButtonIconSize);
const mobileEllipsisIcon = createSizedIcon(lucideIcons.Ellipsis, mobileButtonIconSize);
const mobileFilterIcon = createSizedIcon(lucideIcons.ListFilter, mobileButtonIconSize);

/**
 * Icons for the per-folder / repo / worktree row (⋯) menu items. Sized down from lucide's native
 * 24px so they sit proportionally next to the menu label text.
 */
const menuIconSize = 16;
const menuOpenPrIcon = createSizedIcon(lucideIcons.ExternalLink, menuIconSize);
const menuEditCommandsIcon = createSizedIcon(lucideIcons.Terminal, menuIconSize);
const menuRestartPanesIcon = createSizedIcon(lucideIcons.RotateCw, menuIconSize);
const menuKillPanesIcon = createSizedIcon(lucideIcons.PowerOff, menuIconSize);
const menuHideRepoIcon = createSizedIcon(lucideIcons.Archive, menuIconSize);
const menuDeleteWorktreeIcon = createSizedIcon(lucideIcons.Trash2, menuIconSize);
const menuRemoveRepoIcon = createSizedIcon(lucideIcons.X, menuIconSize);

const sidebarGroupingLabels: Record<SidebarGrouping, string> = {
    [SidebarGrouping.Repo]: 'Group by repo',
    [SidebarGrouping.Status]: 'Group by status',
};

const sidebarSortingLabels: Record<SidebarSorting, string> = {
    [SidebarSorting.Name]: 'Sort by name',
    [SidebarSorting.Date]: 'Sort by created',
    [SidebarSorting.Activity]: 'Sort by activity',
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
    /** AI chosen on the "Add repo" modal. {@link defaultAiSelectValue} means inherit the default. */
    repoAiId: string;
    repoSubmitting: boolean;
    worktreeModalRepoPath: string | undefined;
    worktreeName: string;
    /** Same semantics as `repoAiId`, for the "Add worktree" modal. */
    worktreeAiId: string;
    worktreeSubmitting: boolean;
    /**
     * Folder whose AI is being changed in the picker modal. `undefined` when the modal is closed;
     * the path is what the override gets written against on save. A worktree root's choice is
     * inherited by every child that doesn't set its own.
     */
    changeAiFolderPath: string | undefined;
    changeAiSelectedId: string;
    /**
     * Name of the AI the folder falls back to with no override — a worktree's parent-repo choice if
     * it has one, else the global default. Shown on the picker's "Inherit" row.
     */
    changeAiInheritedName: string;
    changeAiIsWorktreeRoot: boolean;
    changeAiSubmitting: boolean;
    /**
     * Mirrors `config.aiDefinitions` so the picker and the add-repo / add-worktree modals can list
     * the user's AIs. Kept in lockstep with the folders list via `refresh()`.
     */
    aiDefinitions: ReadonlyArray<AiDefinition>;
    /** Mirrors `config.defaultAiId`, used to name what an un-overridden folder inherits. */
    defaultAiId: string;
    /**
     * Mirrors `config.sidebarGrouping`. Fetched lazily on first refresh tick so the filter menu can
     * show which grouping is currently active (and so flipping it via the menu has a fresh value to
     * write back into config). `undefined` while we haven't loaded config yet.
     */
    sidebarGrouping: SidebarGrouping | undefined;
    /**
     * Mirrors `config.sidebarSorting`. Picks the comparator used for the standalone list, the
     * worktree roots, and each root's children. `undefined` while config hasn't loaded, which sorts
     * the same as {@link SidebarSorting.Name}.
     */
    sidebarSorting: SidebarSorting | undefined;
    /**
     * Mirrors `config.onlyShowRecent`. When true the sidebar hides standalone repos that lack
     * recent activity AND have no running panes; worktree-roots and their children are always
     * shown. `undefined` while config hasn't loaded yet, which renders the same as `false`.
     */
    onlyShowRecent: boolean | undefined;
    /**
     * Live text from the header search pop-up. While non-empty it temporarily overrides the
     * hide-inactive filter and shows only repos/worktrees whose names match (searching active and
     * inactive repos alike). Persists after the pop-up closes — clearing the input (or its clear
     * button) is what ends the search.
     */
    searchQuery: string;
    /**
     * The search pop-up's own manager, grabbed from its `init` event. `ViraPopUpTrigger` has no
     * `open` input, so this is the only way to close the pop-up from the outside — needed when
     * Enter in the search input activates the top result.
     */
    searchPopUpManager: PopUpManager | undefined;
    /**
     * Mirrors `config.repos`. Needed for the hide-inactive filter so we can look up each repo's
     * `lastInteractedAtMs` against the 7-day cutoff. Kept in lockstep with the folders list via
     * `refresh()`.
     */
    repos: ReadonlyArray<RepoConfig>;
    /**
     * Result of the backend's "agent-storm checkout vs upstream `dev`" probe. The banner at the
     * bottom of the sidebar appears only when `isUpToDate === false`; every other value (including
     * the `null`s the backend returns when it can't determine status, or when the user has disabled
     * the check) keeps the banner hidden. `undefined` while the first poll is still in flight.
     */
    updateStatus: UpdateStatus | undefined;
};

type SidebarUpdate = (newState: Partial<SidebarState>) => void;

const closedChangeAiState: Partial<SidebarState> = {
    changeAiFolderPath: undefined,
    changeAiSelectedId: '',
    changeAiInheritedName: '',
    changeAiIsWorktreeRoot: false,
    changeAiSubmitting: false,
};

type PaneRestartedEvent = {
    folder: string;
    kind: PaneKind;
};

export const VirSidebar = defineElement<{
    activeFolder: string | undefined;
    hideBorder?: boolean | undefined;
    mobileModal?: boolean | undefined;
    /** App-owned Vira theme client, used by the options menu's theme switcher. */
    themeClient: Readonly<ViraThemeClient>;
}>()({
    tagName: 'vir-sidebar',
    options: {
        errorHandler: reportRenderError,
    },
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
        /** Same deal for the "Define AI" item, which the parent renders as its own modal. */
        openAiModalRequested: defineElementEvent<void>(),
    },
    state(): SidebarState {
        return {
            folders: [],
            pollHandle: undefined,
            loadError: undefined,
            openMenuKey: undefined,
            repoModalOpen: false,
            repoPath: '',
            repoAiId: defaultAiSelectValue,
            repoSubmitting: false,
            worktreeModalRepoPath: undefined,
            worktreeName: '',
            worktreeAiId: defaultAiSelectValue,
            worktreeSubmitting: false,
            changeAiFolderPath: undefined,
            changeAiSelectedId: '',
            changeAiInheritedName: '',
            changeAiIsWorktreeRoot: false,
            changeAiSubmitting: false,
            aiDefinitions: [],
            defaultAiId: '',
            sidebarGrouping: undefined,
            sidebarSorting: undefined,
            onlyShowRecent: undefined,
            searchQuery: '',
            searchPopUpManager: undefined,
            repos: [],
            updateStatus: undefined,
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
            /* No overflow clipping here on purpose: the header search pop-up grows past the
               sidebar's right edge, and an overflow container at this level would clip it (the
               pop-up manager constrains pop-ups to the nearest overflow ancestor). Scrolling lives
               on the list instead, so the only thing that needs clipping still gets it. */
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

        /* The theme switcher sits inside the options menu above the Settings item; give it breathing
           room so it doesn't crowd the menu edges or the item below it. */
        /* Section break inside a menu pop-up. The pop-up's content is a plain slot, so an <hr>
           lands between two runs of menu items with no vira support needed. */
        .menu-divider {
            border: none;
            border-top: 1px solid ${viraThemeByKeys.grey['behind-bg'].decoration.background.value};
            margin: 4px 0;
            width: 100%;
        }

        .theme-switcher-menu-row {
            display: flex;
            justify-content: center;
            padding: 8px 10px;
        }

        /* Card behind the search input so the pop-up reads as a panel, not a bare floating input.
           Mirrors vira's own menu pop-up surface (background/border/radius/shadow). */
        .search-popup {
            padding: 10px;
            min-width: 220px;
            box-sizing: border-box;
            background-color: ${viraFormCssVars['vira-form-background-color'].value};
            color: ${viraFormCssVars['vira-form-foreground-color'].value};
            border: 1px solid ${viraFormCssVars['vira-form-border-color'].value};
            border-radius: ${viraFormCssVars['vira-form-radius'].value};
            ${viraShadows.menuShadow}
        }

        .list {
            flex-grow: 1;
            /* min-height: 0 lets this flex child shrink below its content height so it scrolls
               within the column instead of pushing the host taller (now that the host no longer
               clips). overflow-x: hidden keeps long folder names clipped to the sidebar width. */
            min-height: 0;
            overflow-y: auto;
            overflow-x: hidden;
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

        /* Deliberately outside the header's bold weight so only the repo name reads as a heading. */
        .worktree-count {
            font-weight: 400;
            color: ${viraThemeByKeys.grey.foreground['non-body'].foreground.value};
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

        .update-banner {
            flex-shrink: 0;
            padding: 6px 10px;
            font-size: 11px;
            text-align: center;
            /**
             * The vira palette has no "orange" key — yellow is the warning slot and reads as
             * orange-adjacent in both light and dark modes, which matches the user's intent
             * (attention-grabbing but not error-red).
             */
            ${colorCss(viraThemeByKeys.yellow['behind-bg'].body)};
            border-top: 1px solid ${viraThemeByKeys.yellow['behind-bg'].decoration.background.value};
        }

        :host([data-mobile-modal]) .update-banner {
            font-size: 13px;
            padding: 10px 16px;
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

        /*
         * Loosen up spacing between the header action buttons on mobile — the buttons themselves
         * are bigger (ViraSize.Large, ~40px) and packed too tightly at the desktop gap would still
         * create thumb-spanning mis-taps between adjacent targets.
         */
        :host([data-mobile-modal]) .header-actions {
            gap: 10px;
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
         * Apply the active filter once up front. The standalone list, the worktree roots, and each
         * root's children all iterate this same pre-filtered array so hidden entries disappear
         * consistently and the empty-state message below stays accurate. An active search query
         * wins over the hide-inactive filter (search spans active and inactive repos alike).
         */
        const trimmedSearchQuery = state.searchQuery.trim();
        const visibleFolders = trimmedSearchQuery
            ? filterBySearch(state.folders, trimmedSearchQuery)
            : state.onlyShowRecent
              ? filterByRecency(state.folders, state.repos)
              : state.folders;
        const folderComparator = folderComparators[state.sidebarSorting ?? SidebarSorting.Name];
        const standaloneFolders = visibleFolders
            .filter((folder) => !folder.isWorktreeRoot && !folder.parentRepoPath)
            .toSorted(folderComparator);
        /** See {@link folderComparators} for why repo headers ignore the selected sorting. */
        const worktreeRoots = visibleFolders
            .filter((folder) => folder.isWorktreeRoot)
            .toSorted(folderComparators[SidebarSorting.Name]);
        const sortedChildrenOf = (rootPath: string) =>
            visibleFolders
                .filter((folder) => folder.parentRepoPath === rootPath)
                .toSorted(folderComparator);
        /**
         * What Enter in the search input opens: the first row of the rendered list, in the same
         * top-to-bottom order the user sees. Repo headers are skipped because they aren't
         * activatable — a repo with matching worktrees hands off to its first worktree.
         */
        const firstSearchResult = trimmedSearchQuery
            ? (standaloneFolders[0] ??
              worktreeRoots.flatMap((root) => sortedChildrenOf(root.path))[0])
            : undefined;
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
            /**
             * Optimistically bump the owning repo's `lastInteractedAtMs` in the local repos mirror
             * so the hide-inactive filter keeps the repo visible the instant the search query is
             * cleared and the view reverts to the recency filter. The backend touch — fired from
             * vir-app's `folderActivated` handler — persists this, but it's async and wouldn't land
             * before the re-filter, so an inactive repo would otherwise vanish until the next poll.
             * Resolve the owning repo the same way the backend does: a worktree's parent repo, else
             * the folder itself.
             */
            const folder = state.folders.find((entry) => entry.path === path);
            const owningRepoPath = folder?.parentRepoPath ?? folder?.path ?? path;
            const now = toTimestamp(getNowInUtcTimezone());
            updateState({
                /**
                 * Clear the active search once the user picks a folder — they've found what they
                 * were looking for, so the sidebar reverts to its normal (hide-inactive) view.
                 */
                searchQuery: '',
                repos: state.repos.map((repo) =>
                    repo.path === owningRepoPath
                        ? {
                              ...repo,
                              lastInteractedAtMs: now,
                          }
                        : repo,
                ),
            });
            dispatch(new events.folderActivated(path));
        };
        const emitPaneRestarted = (detail: PaneRestartedEvent) => {
            dispatch(new events.paneRestarted(detail));
        };
        const closeRepoModal = () => {
            updateState({
                repoModalOpen: false,
                repoPath: '',
                repoAiId: defaultAiSelectValue,
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
                worktreeAiId: defaultAiSelectValue,
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
                </span>
                <span class="header-actions">
                    <${ViraPopUpTrigger.assign({
                        horizontalAnchor: HorizontalAnchor.Left,
                        keepOpenAfterInteraction: true,
                    })}
                        ${listen(ViraPopUpTrigger.events.openChange, (event) => {
                            if (event.detail) {
                                focusSearchInput(host);
                            }
                        })}
                        ${listen(ViraPopUpTrigger.events.init, (event) => {
                            updateState({
                                searchPopUpManager: event.detail.popUpManager,
                            });
                        })}
                    >
                        <${ViraButton.assign({
                            icon: inputs.mobileModal ? mobileSearchIcon : searchIcon,
                            buttonSize: inputs.mobileModal ? ViraSize.Large : ViraSize.Small,
                            /**
                             * Bump the search button to Standard emphasis while a search is active
                             * so it stays visibly "on" after the pop-up closes — the query persists
                             * past close, so the filter is still applied even with the pop-up
                             * shut.
                             */
                            buttonEmphasis: trimmedSearchQuery
                                ? ViraEmphasis.Standard
                                : ViraEmphasis.Subtle,
                            color: ViraColorVariant.Plain,
                        })}
                            slot=${ViraPopUpTrigger.slotNames['vira-pop-up-trigger-trigger']}
                            title="Search repos & worktrees"
                        ></${ViraButton}>
                        <div
                            class="search-popup"
                            slot=${ViraPopUpTrigger.slotNames['vira-pop-up-trigger-pop-up']}
                        >
                            <${ViraInput.assign({
                                value: state.searchQuery,
                                placeholder: 'Search repos & worktrees',
                                showClearButton: true,
                            })}
                                class="search-input"
                                ${listen(ViraInput.events.valueChange, (event) => {
                                    updateState({
                                        searchQuery: event.detail,
                                    });
                                })}
                                ${listen('keydown', (event) => {
                                    if (
                                        !(event instanceof KeyboardEvent) ||
                                        event.key !== 'Enter' ||
                                        !firstSearchResult
                                    ) {
                                        return;
                                    }
                                    emitFolderActivated(firstSearchResult.path);
                                    /**
                                     * `keepOpenAfterInteraction` means picking a result won't close
                                     * the pop-up on its own, and leaving it floating over a sidebar
                                     * that just jumped to the new folder is disorienting.
                                     */
                                    state.searchPopUpManager?.removePopUp();
                                })}
                            ></${ViraInput}>
                        </div>
                    </${ViraPopUpTrigger}>
                    <${ViraButton.assign({
                        /**
                         * Mobile (where the sidebar lives inside `ViraModal` on small screens) uses
                         * the 40px-tall `Large` button + 24px icon so the tap target sits closer to
                         * Apple HIG's 44px guideline. The desktop docked sidebar keeps the compact
                         * 24px `Small` version where mouse precision makes that fine.
                         */
                        icon: inputs.mobileModal ? mobilePlusIcon : plusIcon,
                        buttonSize: inputs.mobileModal ? ViraSize.Large : ViraSize.Small,
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
                            icon: inputs.mobileModal ? mobileFilterIcon : filterIcon,
                            buttonSize: inputs.mobileModal ? ViraSize.Large : ViraSize.Small,
                            buttonEmphasis: ViraEmphasis.Subtle,
                            color: ViraColorVariant.Neutral,
                        })}
                            slot=${ViraMenuTrigger.slotNames['vira-menu-trigger-trigger']}
                            title="Filter & group sidebar"
                        ></${ViraButton}>
                        ${buildFilterMenuSections({
                            sidebarGrouping: state.sidebarGrouping,
                            sidebarSorting: state.sidebarSorting,
                            onlyShowRecent: state.onlyShowRecent,
                            updateState,
                        }).map((section, index) => {
                            return html`
                                ${index
                                    ? html`
                                          <hr class="menu-divider" />
                                      `
                                    : ''}
                                ${renderMenuItemEntries(section)}
                            `;
                        })}
                    </${ViraMenuTrigger}>
                    <${ViraMenuTrigger.assign({
                        horizontalAnchor: HorizontalAnchor.Right,
                    })}
                        ${listen(ViraMenuTrigger.events.openChange, (event) => {
                            updateState({
                                openMenuKey: event.detail ? 'sidebar-settings' : undefined,
                            });
                        })}
                    >
                        <${ViraButton.assign({
                            icon: inputs.mobileModal ? mobileEllipsisIcon : ellipsisIcon,
                            buttonSize: inputs.mobileModal ? ViraSize.Large : ViraSize.Small,
                            buttonEmphasis: ViraEmphasis.Subtle,
                            color: ViraColorVariant.Neutral,
                        })}
                            slot=${ViraMenuTrigger.slotNames['vira-menu-trigger-trigger']}
                            title="More options"
                        ></${ViraButton}>
                        <div class="theme-switcher-menu-row">
                            <${ViraThemeSwitcher.assign({
                                themeClient: inputs.themeClient,
                            })}></${ViraThemeSwitcher}>
                        </div>
                        ${renderMenuItemEntries([
                            {
                                content: 'Define AI',
                                onClick: () => {
                                    dispatch(new events.openAiModalRequested());
                                },
                            },
                            {
                                content: 'Settings',
                                onClick: () => {
                                    dispatch(new events.openSettingsRequested());
                                },
                            },
                        ])}
                    </${ViraMenuTrigger}>
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
                    const children = sortedChildrenOf(root.path);
                    const repoMenuKey = `repo:${root.path}`;
                    return html`
                        <div
                            class="repo-header"
                            ?data-menu-open=${state.openMenuKey === repoMenuKey}
                        >
                            <span>
                                ${root.name}
                                <!-- Counted from the unfiltered list so the number is the repo's real
                                worktree count, not however many survived the current filters. -->
                                <span class="worktree-count">
                                    (${state.folders.filter(
                                        (folder) => folder.parentRepoPath === root.path,
                                    ).length})
                                </span>
                            </span>
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
                                        slot=${ViraMenuTrigger.slotNames[
                                            'vira-menu-trigger-trigger'
                                        ]}
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
                                            /**
                                             * The root's AI is what every child worktree inherits
                                             * (unless the child sets its own), so this is the one
                                             * place to change the AI for a whole repo's worktrees
                                             * at once.
                                             */
                                            content: 'Change AI',
                                            iconOverride: menuEditCommandsIcon,
                                            onClick: () => {
                                                void openChangeAiModal(root, updateState);
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
            ${state.updateStatus?.isUpToDate === false
                ? html`
                      <div
                          class="update-banner"
                          title="Run \`git pull\` in your agent-storm checkout."
                      >
                          pull from github to update
                      </div>
                  `
                : ''}
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
                        disableBrowserHelps: true,
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
                    <${ViraSelect.assign({
                        label: 'AI',
                        options: aiSelectOptions(state),
                        value: state.repoAiId,
                        disabled: state.repoSubmitting,
                    })}
                        ${listen(ViraSelect.events.valueChange, (event) => {
                            updateState({
                                repoAiId: event.detail,
                            });
                        })}
                    ></${ViraSelect}>
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
                        disableBrowserHelps: true,
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
                    <${ViraSelect.assign({
                        label: 'AI',
                        /**
                         * The repo root's resolved AI, which the new worktree inherits when the
                         * user leaves this on "Default". `FolderInfo.aiId` already walked the
                         * override chain on the backend, so there's no config lookup to redo here.
                         */
                        options: aiSelectOptions(
                            state,
                            state.folders.find(
                                (folder) => folder.path === state.worktreeModalRepoPath,
                            )?.aiId,
                        ),
                        value: state.worktreeAiId,
                        disabled: state.worktreeSubmitting,
                    })}
                        ${listen(ViraSelect.events.valueChange, (event) => {
                            updateState({
                                worktreeAiId: event.detail,
                            });
                        })}
                    ></${ViraSelect}>
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
            <${VirAiPickerModal.assign({
                open: !!state.changeAiFolderPath,
                modalTitle: state.changeAiIsWorktreeRoot
                    ? 'Change AI (inherited by worktrees)'
                    : 'Change AI',
                aiDefinitions: state.aiDefinitions,
                selectedAiId: state.changeAiSelectedId,
                inheritedName: state.changeAiInheritedName,
                submitting: state.changeAiSubmitting,
            })}
                ${listen(VirAiPickerModal.events.closeRequested, () =>
                    updateState(closedChangeAiState),
                )}
                ${listen(VirAiPickerModal.events.aiSaveRequested, (event) => {
                    void submitChangeAi({
                        aiId: event.detail,
                        state,
                        updateState,
                        emitPaneRestarted,
                    });
                })}
            ></${VirAiPickerModal}>
        `;
    },
});

/**
 * Focuses the native input inside the header search pop-up once it opens. The pop-up content is
 * slotted into vir-sidebar's shadow root, and `ViraInput` keeps its real `<input>` in its own
 * shadow root, so we reach through both. Deferred a frame because the pop-up manager
 * mounts/positions the element after `openChange` fires — focusing synchronously would target a
 * not-yet-visible node.
 */
function focusSearchInput(host: HTMLElement): void {
    requestAnimationFrame(() => {
        const searchInput = host.shadowRoot?.querySelector('.search-input');
        const nativeInput = searchInput?.shadowRoot?.querySelector('input');
        if (nativeInput instanceof HTMLInputElement) {
            nativeInput.focus();
        }
    });
}

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
                        slot=${ViraMenuTrigger.slotNames['vira-menu-trigger-trigger']}
                        title="Folder actions"
                    ></${ViraButton}>
                    ${renderMenuItemEntries(
                        buildRowMenuEntries({
                            folder,
                            updateState,
                            removeFolderLocally,
                            emitFoldersRemoved,
                            emitPaneRestarted,
                        }),
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

/**
 * Applies to the standalone list and to the worktrees within each repo. Repo headers themselves
 * stay alphabetical under every sorting — a header is a place to look things up, so it should sit
 * where the user last saw it rather than shuffle as its worktrees are worked in.
 */
const folderComparators: Record<SidebarSorting, (a: FolderInfo, b: FolderInfo) => number> = {
    [SidebarSorting.Name]: (a, b) =>
        a.name.localeCompare(b.name, undefined, {
            sensitivity: 'base',
        }),
    /**
     * Newest-created first. Folders the backend couldn't stat carry `createdAtMs: 0` and land at
     * the end, where they fall back to the name comparator.
     */
    [SidebarSorting.Date]: (a, b) =>
        b.createdAtMs - a.createdAtMs || folderComparators[SidebarSorting.Name](a, b),
    /**
     * Most-recently-typed-in first. Folders nobody has typed in carry `0` and land at the end,
     * where they fall back to the name comparator.
     */
    [SidebarSorting.Activity]: (a, b) =>
        b.lastActivityAtMs - a.lastActivityAtMs || folderComparators[SidebarSorting.Name](a, b),
};

/**
 * Grouped rather than flat so the render can draw a divider between each section: grouping, then
 * sorting, then the standalone filters.
 */
function buildFilterMenuSections({
    sidebarGrouping,
    sidebarSorting,
    onlyShowRecent,
    updateState,
}: Readonly<{
    sidebarGrouping: SidebarGrouping | undefined;
    sidebarSorting: SidebarSorting | undefined;
    onlyShowRecent: boolean | undefined;
    updateState: SidebarUpdate;
}>): ReadonlyArray<ReadonlyArray<ViraMenuItemEntry>> {
    const groupingEntries: ReadonlyArray<ViraMenuItemEntry> = [
        SidebarGrouping.Repo,
        SidebarGrouping.Status,
    ].map((grouping) => {
        return {
            content: sidebarGroupingLabels[grouping],
            /**
             * Mark the active grouping with a check; non-active entries get no icon. `iconOverride`
             * is the menu's per-item icon slot — leaving it undefined leaves blank space, which
             * keeps the labels visually aligned across rows.
             */
            iconOverride: sidebarGrouping === grouping ? lucideIcons.Check : undefined,
            onClick: () => {
                if (sidebarGrouping === grouping) {
                    return;
                }
                void setSidebarGrouping(grouping, updateState);
            },
        };
    });
    /**
     * The sort options are mutually exclusive: picking one writes the single
     * `config.sidebarSorting` value, which drops the check from the others.
     */
    const sortingEntries: ReadonlyArray<ViraMenuItemEntry> = [
        SidebarSorting.Name,
        SidebarSorting.Date,
        SidebarSorting.Activity,
    ].map((sorting) => {
        return {
            content: sidebarSortingLabels[sorting],
            iconOverride:
                (sidebarSorting ?? SidebarSorting.Name) === sorting ? lucideIcons.Check : undefined,
            onClick: () => {
                if ((sidebarSorting ?? SidebarSorting.Name) === sorting) {
                    return;
                }
                void setSidebarSorting(sorting, updateState);
            },
        };
    });
    return [
        groupingEntries,
        sortingEntries,
        [
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
        ],
    ];
}

/**
 * Respawn every session of both kinds under one folder, then remount their terminals. Unlike "Kill
 * panes" the tab list survives — this is the recovery path for panes whose processes are gone (a
 * daemon that ran out of PTYs, an agent that crashed) rather than a teardown.
 */
async function restartFolderPanes({
    folder,
    updateState,
    emitPaneRestarted,
}: Readonly<{
    folder: string;
    updateState: SidebarUpdate;
    emitPaneRestarted: (detail: PaneRestartedEvent) => void;
}>): Promise<void> {
    try {
        const sessions = await getFolderSessions({
            folder,
        });
        await awaitedForEach(getObjectTypedValues(PaneKind), async (kind) => {
            /**
             * Serial rather than parallel: each restart spawns a shell that sources the user's
             * profile, and a folder with several tabs per kind would otherwise fire all of them at
             * once.
             */
            await awaitedForEach(sessions[kind], async (session) => {
                await restartPane({
                    folder,
                    kind,
                    sessionId: session.id,
                });
            });
            emitPaneRestarted({
                folder,
                kind,
            });
        });
    } catch (error: unknown) {
        showError(updateState, error);
    }
}

function buildRowMenuEntries({
    folder,
    updateState,
    removeFolderLocally,
    emitFoldersRemoved,
    emitPaneRestarted,
}: Readonly<{
    folder: FolderInfo;
    updateState: SidebarUpdate;
    removeFolderLocally: (path: string) => void;
    emitFoldersRemoved: (paths: ReadonlyArray<string>) => void;
    emitPaneRestarted: (detail: PaneRestartedEvent) => void;
}>): ReadonlyArray<ViraMenuItemEntry> {
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
                iconOverride: menuOpenPrIcon,
            },
        {
            content: 'Change AI',
            iconOverride: menuEditCommandsIcon,
            onClick: () => {
                void openChangeAiModal(folder, updateState);
            },
        },
        {
            content: 'Restart panes',
            iconOverride: menuRestartPanesIcon,
            onClick: () => {
                void restartFolderPanes({
                    folder: folder.path,
                    updateState,
                    emitPaneRestarted,
                });
            },
        },
        {
            content: 'Kill panes',
            iconOverride: menuKillPanesIcon,
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
        /**
         * Standalone repos only (worktree children carry a `parentRepoPath`). Clears the repo's
         * `lastInteractedAtMs`, which the recency filter treats as hidden — the repo drops out of
         * the default sidebar list but still surfaces in search and the unfiltered view. Also kills
         * the folder's panes (same as "Kill panes") so hiding a repo tears down its running PTYs
         * and drops it from `openedFolders`/route via `foldersRemoved`, rather than leaving a
         * hidden-but-running session behind. Refresh the config mirror afterward so the filter
         * (which reads `state.repos`) reflects the cleared timestamp without waiting for the next
         * poll.
         */
        !folder.parentRepoPath && {
            content: 'Hide repo',
            iconOverride: menuHideRepoIcon,
            onClick: () => {
                void (async () => {
                    try {
                        await hideRepo({
                            folder: folder.path,
                        });
                        await killFolderPanes({
                            folder: folder.path,
                        });
                        emitFoldersRemoved([folder.path]);
                        const refreshedConfig = await getConfig();
                        updateState({
                            repos: refreshedConfig.repos,
                        });
                    } catch (error: unknown) {
                        showError(updateState, error);
                    }
                })();
            },
        },
        folder.parentRepoPath
            ? {
                  content: 'Delete worktree',
                  iconOverride: menuDeleteWorktreeIcon,
                  onClick: () => {
                      void confirmDeleteWorktree({
                          worktreePath: folder.path,
                          updateState,
                          removeFolderLocally,
                          notifyRemoved: () => emitFoldersRemoved([folder.path]),
                      });
                  },
              }
            : {
                  content: 'Remove repo',
                  iconOverride: menuRemoveRepoIcon,
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
         * Fetch folders + config + update-status in parallel. Config tells us the current
         * `sidebarGrouping` so the filter menu can mark the active choice; folders feeds the list;
         * update-status drives the "pull from github" banner. The backend caches update-status for
         * ~10 minutes, so calling it on every 2s poll is fine — almost every call returns instantly
         * from the cache without hitting the GitHub remote.
         */
        const [
            folders,
            config,
            updateStatus,
        ] = await Promise.all([
            getFolders(),
            getConfig(),
            getUpdateStatus().catch(() => undefined),
        ]);
        updateState({
            folders: pendingWorktreeDeletions.size
                ? folders.filter((folder) => !pendingWorktreeDeletions.has(folder.path))
                : folders,
            loadError: undefined,
            sidebarGrouping: config.sidebarGrouping,
            sidebarSorting: config.sidebarSorting,
            onlyShowRecent: config.onlyShowRecent,
            repos: config.repos,
            aiDefinitions: config.aiDefinitions,
            defaultAiId: config.defaultAiId,
            updateStatus,
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

async function setSidebarSorting(
    sorting: SidebarSorting,
    updateState: SidebarUpdate,
): Promise<void> {
    try {
        const config = await getConfig();
        await putConfig({
            ...config,
            sidebarSorting: sorting,
        });
        updateState({
            sidebarSorting: sorting,
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

/**
 * Filters folders by the header search query (case-insensitive substring on folder names),
 * searching active and inactive repos alike (recency is ignored while searching):
 *
 * - A standalone repo shows when its own name matches.
 * - A worktree child shows when its own name matches OR its parent worktree-root's name matches (so
 *   matching a repo surfaces all of its worktrees to pick from).
 * - A worktree-root shows when its own name matches OR at least one of its children matches.
 *   Therefore a worktree-root with no matching child and a non-matching name is hidden entirely.
 */
function filterBySearch(folders: ReadonlyArray<FolderInfo>, query: string): FolderInfo[] {
    const needle = query.trim().toLowerCase();
    const nameMatches = (folder: FolderInfo): boolean => folder.name.toLowerCase().includes(needle);
    const matchingRootPaths = new Set(
        folders
            .filter((folder) => folder.isWorktreeRoot && nameMatches(folder))
            .map((folder) => folder.path),
    );
    const rootPathsWithMatchingChild = new Set(
        filterMap(
            folders,
            (folder) => folder.parentRepoPath,
            (parentRepoPath, folder): parentRepoPath is string =>
                !!parentRepoPath && nameMatches(folder),
        ),
    );
    return folders.filter((folder) => {
        if (folder.isWorktreeRoot) {
            return (
                matchingRootPaths.has(folder.path) || rootPathsWithMatchingChild.has(folder.path)
            );
        } else if (folder.parentRepoPath) {
            return nameMatches(folder) || matchingRootPaths.has(folder.parentRepoPath);
        } else {
            return nameMatches(folder);
        }
    });
}

/**
 * Value of the "use the default AI" entry in the add-repo / add-worktree selects. Deliberately not
 * the empty string, which `ViraSelect` coerces to "nothing selected" — it then renders its own
 * hidden placeholder option as selected and the field comes up blank. Mapped back to "no override"
 * at submit time.
 */
const defaultAiSelectValue = 'default';

/**
 * Options for every AI select: the definitions, preceded by a "use the default" entry carrying
 * {@link defaultAiSelectValue}.
 *
 * `inheritedAiId` is what the thing being created will actually fall back to, which is not always
 * the global default — a new worktree inherits its repo root's override. Empty means nothing sits
 * between the new folder and `config.defaultAiId`.
 */
function aiSelectOptions(
    state: Readonly<SidebarState>,
    inheritedAiId?: string | undefined,
): ViraSelectOption[] {
    const defaultName =
        state.aiDefinitions.find(
            (definition) => definition.id === (inheritedAiId || state.defaultAiId),
        )?.name ||
        state.aiDefinitions[0]?.name ||
        '';
    return [
        {
            value: defaultAiSelectValue,
            label: defaultName ? `Default (${defaultName})` : 'Default',
        },
        ...state.aiDefinitions.map((definition) => {
            return {
                value: definition.id,
                label: definition.name,
            };
        }),
    ];
}

/**
 * Open the "Change AI" picker for a folder, seeded with its current override. Works for a
 * standalone repo, a worktree child, and a worktree root — the root's choice acts as the default
 * its children inherit, so the "Inherit" row names whatever the folder currently falls back to
 * (parent override, else the global default).
 */
async function openChangeAiModal(folder: FolderInfo, updateState: SidebarUpdate): Promise<void> {
    try {
        const config = await getConfig();
        const override = config.folderAiIds.find((entry) => entry.folder === folder.path);
        const parentOverrideId = folder.parentRepoPath
            ? config.folderAiIds.find((entry) => entry.folder === folder.parentRepoPath)?.aiId
            : undefined;
        const inherited =
            config.aiDefinitions.find((definition) => definition.id === parentOverrideId) ||
            config.aiDefinitions.find((definition) => definition.id === config.defaultAiId) ||
            config.aiDefinitions[0];
        updateState({
            aiDefinitions: config.aiDefinitions,
            defaultAiId: config.defaultAiId,
            changeAiFolderPath: folder.path,
            changeAiSelectedId: override?.aiId || '',
            changeAiInheritedName: inherited?.name || '',
            changeAiIsWorktreeRoot: folder.isWorktreeRoot,
            changeAiSubmitting: false,
        });
    } catch (error: unknown) {
        showError(updateState, error);
    }
}

/**
 * Write the folder's AI choice into `folderAiIds` (an empty id drops the override so the folder
 * inherits again), then restart its AI pane so the new command actually takes effect — a running
 * pane keeps whatever it was spawned with.
 */
async function submitChangeAi({
    aiId,
    state,
    updateState,
    emitPaneRestarted,
}: Readonly<{
    aiId: string;
    state: SidebarState;
    updateState: SidebarUpdate;
    emitPaneRestarted: (detail: PaneRestartedEvent) => void;
}>): Promise<void> {
    const folderPath = state.changeAiFolderPath;
    if (!folderPath || state.changeAiSubmitting) {
        return;
    }
    try {
        updateState({
            changeAiSubmitting: true,
        });
        const config = await getConfig();
        const otherEntries = config.folderAiIds.filter((entry) => entry.folder !== folderPath);
        await putConfig({
            ...config,
            folderAiIds: aiId
                ? [
                      ...otherEntries,
                      {
                          folder: folderPath,
                          aiId,
                      },
                  ]
                : otherEntries,
        });
        /**
         * Only the edited folder's own AI pane restarts. Worktrees that inherit a root's choice
         * keep their running agents — killing a batch of in-progress sessions is never worth
         * applying the change eagerly, and each one picks up the new AI on its next restart
         * anyway.
         */
        const hasRunningAiPane =
            state.folders.find((folder) => folder.path === folderPath)?.panes.ai !==
            PaneStatus.None;
        if (hasRunningAiPane) {
            await restartPane({
                folder: folderPath,
                kind: PaneKind.Ai,
            });
            emitPaneRestarted({
                folder: folderPath,
                kind: PaneKind.Ai,
            });
        }
        updateState(closedChangeAiState);
        await refresh(updateState);
    } catch (error: unknown) {
        updateState({
            changeAiSubmitting: false,
        });
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
            repoAiId: defaultAiSelectValue,
            aiDefinitions: config.aiDefinitions,
            defaultAiId: config.defaultAiId,
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
            /**
             * Repo already configured — don't add a duplicate. Stamp its `lastInteractedAtMs` to
             * now (the touch endpoint resolves the owning repo and writes `Date.now()`) so the
             * hide-inactive filter stops hiding it, then pull the refreshed config so the local
             * `repos` mirror that filter reads reflects the new timestamp immediately instead of
             * waiting for the next poll. Finally activate the existing entry.
             */
            await touchRepo({
                folder: path,
            });
            const refreshedConfig = await getConfig();
            updateState({
                repos: refreshedConfig.repos,
                repoModalOpen: false,
                repoPath: '',
                repoAiId: defaultAiSelectValue,
                repoSubmitting: false,
            });
            notifyActivated(path);
            return;
        }
        const otherEntries = config.folderAiIds.filter((entry) => entry.folder !== path);
        await putConfig({
            ...config,
            repos: [
                ...config.repos,
                {
                    path,
                    postWorktreeCmd: null,
                },
            ],
            folderAiIds:
                state.repoAiId === defaultAiSelectValue
                    ? otherEntries
                    : [
                          ...otherEntries,
                          {
                              folder: path,
                              aiId: state.repoAiId,
                          },
                      ],
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
            repoAiId: defaultAiSelectValue,
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
    if (
        !window.confirm(
            [
                `Remove repo ${repoPath}?`,
                'This only removes it from agent-storm; the repo stays on disk.',
            ].join('\n\n'),
        )
    ) {
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
            worktreeAiId: defaultAiSelectValue,
            aiDefinitions: config.aiDefinitions,
            defaultAiId: config.defaultAiId,
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
    try {
        updateState({
            worktreeSubmitting: true,
        });
        await createWorktree({
            repoPath,
            name: trimmedName,
            aiId: state.worktreeAiId === defaultAiSelectValue ? undefined : state.worktreeAiId,
        });
        const folders = await getFolders();
        updateState({
            folders,
            loadError: undefined,
            worktreeModalRepoPath: undefined,
            worktreeName: '',
            worktreeAiId: defaultAiSelectValue,
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

async function confirmDeleteWorktree({
    worktreePath,
    updateState,
    removeFolderLocally,
    notifyRemoved,
}: Readonly<{
    worktreePath: string;
    updateState: SidebarUpdate;
    removeFolderLocally: (path: string) => void;
    notifyRemoved: () => void;
}>): Promise<void> {
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
