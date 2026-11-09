import {
    type ManualReviewState,
    type PaneKind,
    type PaneState,
    type ReviewQueuePr,
    type SessionMeta,
} from '@agent-storm/common';
import {type PartialWithUndefined} from '@augment-vir/common';
import {type HtmlInterpolation} from 'element-vir';
import {type ViraIconSvg, type ViraThemeClient} from 'vira';
import {type FolderDataObservable} from './folder-data.js';
import {type Setting} from './local-storage-client.js';
import {type PaneRestartsObservable} from './pane-restarts.js';
import {type PaneReviewObservable, type ReviewStart} from './pane-review.js';
import {type PrReviewsObservable} from './pr-reviews.js';
import {type ScreenSize} from './screen-size.js';
import {type TabLayout} from './tab-layout.js';
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
        reviewRepo: Readonly<Pick<ReviewQueuePr, 'owner' | 'repoName'>>;
    }>;

/**
 * `vir-app`'s state, handed to every element below it. A new object on each `vir-app` render, so
 * elements given it re-render when any of its observables change.
 */
export type AppContext = Readonly<{
    screenSize: ScreenSize;
    folderData: FolderDataObservable;
    /** PR details and sent verdicts, shared by every tab that reviews a PR. */
    prReviews: PrReviewsObservable;
    themeClient: Readonly<ViraThemeClient>;
    /**
     * Selects a route, starting with an activity id, in whatever shows this context: the window's
     * URL, or an Activity tab's own.
     */
    navigate(paths: ReadonlyArray<string>): void;
    /** Every activity, in the strip's default order. */
    activities: ReadonlyArray<AnyActivityDefinition>;
    /** Each activity's state, keyed by activity id. */
    activityStates: Readonly<Record<string, unknown>>;
    /** Every pane a pane group's tab can hold, in the new-tab menu's order. */
    panes: ReadonlyArray<PaneDefinition>;
    /** Set inside an Activity tab, which can't hold another and doesn't touch remembered selections. */
    isInActivityTab: boolean;
    /**
     * Renders an Activity tab's activity. `vir-app` supplies it because the activities' elements
     * import the pane groups that hold Activity tabs.
     */
    renderActivityTab(
        params: Readonly<{
            paths: ReadonlyArray<string>;
            navigate(paths: ReadonlyArray<string>): void;
        }>,
    ): HtmlInterpolation;
    paneRestarts: PaneRestartsObservable;
    /** The server's tab layouts and vertical tab bar, shared by every window. */
    uiLayout: UiLayoutObservable;
    /** Opens Settings at `target`, or where this window last left it when `target` is undefined. */
    openSettings(target: SettingsTarget | undefined): void;
}>;

/** The parts of the context that are the same objects for the app's whole life. */
export type AppServices = Pick<
    AppContext,
    'folderData' | 'paneRestarts' | 'uiLayout' | 'themeClient' | 'prReviews'
>;

/** An activity's part of the route: the path segments after its id. */
export type ActivityRoute = Readonly<{
    subPaths: ReadonlyArray<string>;
    /** Selects `subPaths` within the activity, wherever this route is shown. */
    navigate(subPaths: ReadonlyArray<string>): void;
}>;

export type ActivityParams<State> = Readonly<{
    context: AppContext;
    /** The value of the activity's `createState`, the same object for the window's whole life. */
    state: State;
}>;

export type ActivityRouteParams<State> = ActivityParams<State> &
    Readonly<{
        route: ActivityRoute;
    }>;

export type ActivitySubPathsParams<State> = ActivityParams<State> &
    Readonly<{
        subPaths: ReadonlyArray<string>;
    }>;

/** A list beside an activity's content that selects what the content shows. */
export type ActivitySidebar<State> = Readonly<{
    /** Where the sidebar's width is stored. */
    widthSetting: Readonly<Setting<number>>;
    render(params: ActivityRouteParams<State>): HtmlInterpolation;
}>;

/**
 * One activity: a vertical tab in the strip left of the sidebar, selected by the first segment of
 * the URL.
 */
export type ActivityDefinition<State = undefined> = Readonly<{
    /** The activity's first URL path segment, which its stored settings are also keyed by. */
    id: string;
    label: string;
    /** Whether the activity is on until the user chooses otherwise. */
    isEnabledByDefault: boolean;
    /**
     * Titles the mobile modal that holds the activity strip and the sidebar. Undefined for an
     * activity that shows the strip inline on mobile instead.
     */
    mobileMenuTitle: string | undefined;
    /** Undefined for an activity whose content fills the whole area. */
    sidebar: ActivitySidebar<State> | undefined;
    /**
     * Keeps the content mounted, hidden, while another activity shows, once it has shown once. Set
     * for content holding live terminals, which unmounting would tear down.
     */
    isKeptMounted: boolean;
    render(
        params: ActivityRouteParams<State> &
            Readonly<{
                isShown: boolean;
            }>,
    ): HtmlInterpolation;
}> &
    PartialWithUndefined<{
        /**
         * Called once per window. Omitted, the activity's state is `undefined`. Each `Observable`
         * directly in the returned object re-renders the app when it changes, so the `find*` and
         * `render*` callbacks see its new value.
         */
        createState(): State;
        /** Shown after the label once known, like the number of PRs waiting on review. */
        findCount(params: ActivityParams<State>): number | undefined;
        /** Where the activity goes when opened with nothing selected: what it last had selected. */
        findRestoredSubPaths(params: ActivityParams<State>): ReadonlyArray<string> | undefined;
        /** Where to go instead when `subPaths` can't be valid. Pushed, so Back returns to it. */
        findRedirect(params: ActivitySubPathsParams<State>): ReadonlyArray<string> | undefined;
        /** Follows the app name in the window title while the activity shows. */
        findTitle(params: ActivitySubPathsParams<State>): string | undefined;
        /** The activity's columns on the Dashboard, which are shown with nothing selected. */
        renderInDashboard(params: ActivityRouteParams<State>): ReadonlyArray<HtmlInterpolation>;
        /**
         * Starts work that lasts as long as the app, whether or not the activity shows. Returns its
         * remover.
         */
        startWithApp(
            params: Readonly<{
                services: AppServices;
                state: State;
                /** Selects `subPaths` within the activity in the window's URL. */
                navigate(subPaths: ReadonlyArray<string>): void;
            }>,
        ): () => void;
    }>;

/**
 * Types an activity, inferring its state from `createState`. Activities are registered by the
 * frontend host, not by this call.
 */
export function defineActivity<State = undefined>(definition: ActivityDefinition<State>) {
    return definition;
}

/** Any activity, as registries hold them. */
export type AnyActivityDefinition = ActivityDefinition<any>;

/**
 * Whether an activity is on. A turned-off activity has no vertical tab, no new-tab entry, and its
 * URL redirects.
 */
export function isActivityEnabled(
    context: Pick<AppContext, 'uiLayout'>,
    activity: Pick<AnyActivityDefinition, 'id' | 'isEnabledByDefault'>,
) {
    return (
        context.uiLayout.value.layout?.enabledActivities[activity.id] ?? activity.isEnabledByDefault
    );
}

/** When a pane group renders a tab's pane. */
export enum PaneMounting {
    /** Only while the tab is on screen. */
    WhileDisplayed = 'whileDisplayed',
    /** From the first time the tab is on screen, so it keeps its scroll position and selection. */
    OnceDisplayed = 'onceDisplayed',
    /** Whenever the tab is in the layout. */
    Always = 'always',
}

/** A session tab's terminal session. */
export type SessionTab = Readonly<{
    kind: PaneKind;
    session: Readonly<SessionMeta>;
    /** How many sessions of this kind the folder has. */
    count: number;
}>;

/** What a pane group knows about itself and hands to each tab's pane. */
export type PaneGroupView = Readonly<{
    folder: string;
    context: AppContext;
    /** True when the pane group is the user's currently focused folder. */
    isActive: boolean;
    isMobile: boolean;
    isReviewFolder: boolean;
    layout: Readonly<TabLayout>;
    paneReview: PaneReviewObservable;
    review: Readonly<ManualReviewState> | undefined;
    reviewStart: Readonly<ReviewStart> | undefined;
    /** Keeps the Diff tab on the manual review while its copy is still being made. */
    isManualReviewStarting: boolean;
    setManualReviewStarting(isManualReviewStarting: boolean): void;
    writeLayout(change: (current: Readonly<TabLayout>) => Readonly<TabLayout>): void;
    openNewTab(
        params: Readonly<{
            kind: string;
            groupId: string | undefined;
            state?: Readonly<Partial<PaneState>> | undefined;
        }>,
    ): Promise<void>;
    /** The session whose terminal grabs focus when it mounts. */
    sessionToFocus: string | undefined;
    focusedTabId: string | undefined;
}>;

/** One tab's pane, as its definition renders it. */
export type PaneRenderParams = PaneGroupView &
    Readonly<{
        tabId: string;
        kind: string;
        /** The pane group's values, with the tab's own state over them. */
        paneState: Readonly<PaneState>;
        isDisplayed: boolean;
        /** Set for a session kind's tab, once its session exists. */
        sessionTab: SessionTab | undefined;
    }>;

/** One entry in the new-tab menu. */
export type NewTabEntry = Readonly<{
    label: string;
    /** The new tab's own state. */
    state: Readonly<Partial<PaneState>> | undefined;
}>;

/** One kind of pane a pane group's tab can hold. */
export type PaneDefinition = Readonly<{
    /** Stored as the kind of every tab showing the pane. */
    id: string;
    /** Names a tab with no name of its own. */
    label(
        params: Readonly<{
            tabState: Readonly<Partial<PaneState>> | undefined;
            context: AppContext;
        }>,
    ): string;
    /** The kind's entries in the new-tab menu. */
    newTabEntries(view: PaneGroupView): ReadonlyArray<NewTabEntry>;
    icon: ViraIconSvg;
    /** Whether the pane runs an AI, which its tab shows and its menu can change. */
    hasAi: boolean;
    mounting: PaneMounting;
    isAvailable(view: PaneGroupView): boolean;
    render(params: PaneRenderParams): HtmlInterpolation;
}>;
