import {type PartialWithUndefined} from '@augment-vir/common';
import {type HtmlInterpolation, type Observable} from 'element-vir';
import {type ViraThemeClient} from 'vira';
import {type ReviewedRepo} from '../ui/elements/review-sidebar-display.js';
import {type resolveAppRoute} from './app-route.js';
import {type FolderDataObservable} from './folder-data.js';
import {type FrontendStateObservable, type PrQueueKind} from './frontend-state.js';
import {type PaneRestartsObservable} from './pane-restarts.js';
import {type AppRoute, type AppRouteUpdate} from './router.js';
import {type ScreenSize} from './screen-size.js';
import {type UiLayoutObservable} from './ui-layout.js';

/** One page of the Settings modal. Its tabs list in this order. */
export enum SettingsSection {
    General = 'general',
    Terminal = 'terminal',
    Sidebar = 'sidebar',
    Diff = 'diff',
    Activities = 'activities',
    Ai = 'ai',
    Folders = 'folders',
    Review = 'review',
    Forges = 'forges',
    Maintenance = 'maintenance',
}

/** Where the Settings modal is open. */
export type SettingsTarget = Readonly<{
    section: SettingsSection;
}> &
    PartialWithUndefined<{
        /** The folder the Folders section edits. */
        folder: string;
        /** The repo the Review section lists first, even before it has a command of its own. */
        reviewRepo: Readonly<ReviewedRepo>;
    }>;

/**
 * `vir-app`'s state, handed to every element below it. A new object on each `vir-app` render, so
 * elements given it re-render when any of its observables change.
 */
export type AppContext = Readonly<{
    route: AppRoute;
    resolved: Readonly<ReturnType<typeof resolveAppRoute>>;
    screenSize: ScreenSize;
    folderData: FolderDataObservable;
    /** Undefined until IndexedDB opens. */
    frontendState: FrontendStateObservable | undefined;
    themeClient: Readonly<ViraThemeClient>;
    /** Selects a route in whatever shows this context: the window's URL, or an Activity tab's own. */
    navigate(route: AppRouteUpdate): void;
    /** Set inside an Activity tab, which can't hold another and doesn't touch remembered selections. */
    isInActivityTab: boolean;
    /**
     * Renders an Activity tab's activity. `vir-app` supplies it because the activities' elements
     * import the pane groups that hold Activity tabs.
     */
    renderActivityTab(
        params: Readonly<{
            paths: ReadonlyArray<string>;
            navigate(route: AppRouteUpdate): void;
        }>,
    ): HtmlInterpolation;
    paneRestarts: PaneRestartsObservable;
    /** The server's tab layouts and vertical tab bar, shared by every window. */
    uiLayout: UiLayoutObservable;
    /** Where the Settings modal is, or was last left in this window. */
    settingsTarget: Observable<SettingsTarget>;
    isSettingsOpen: Observable<boolean>;
    /** Opens Settings at `target`, or where this window last left it when `target` is undefined. */
    openSettings(target: SettingsTarget | undefined): void;
    /**
     * The Review tab's list. Undefined until picked this session, so the stored pick can load
     * later.
     */
    reviewQueue: Observable<PrQueueKind | undefined>;
    /**
     * Set to a new object each time the user selects a PR, which clears that PR's review folder
     * error so the folder is asked for again.
     */
    reviewRetry: Observable<Readonly<{key: string}> | undefined>;
}>;
