import {
    type PaneKind,
    type SchemaSettingKey,
    type SessionMeta,
    type Settings,
    type TabState,
} from '@agent-storm/common';
import {assertWrap} from '@augment-vir/assert';
import {type PartialWithUndefined} from '@augment-vir/common';
import {type HtmlInterpolation, type ObservableBase} from 'element-vir';
import {defineShape, type Shape} from 'object-shape-tester';
import {type ViraIconSvg, type ViraThemeClient} from 'vira';
import {type FolderDataObservable} from './folder-data.js';
import {type FolderSessionsObservable} from './folder-sessions.js';
import {type Setting} from './local-storage-client.js';
import {type PaneRestartsObservable} from './pane-restarts.js';
import {type ScreenSize} from './screen-size.js';
import {type TabLayout} from './tab-layout.js';
import {type UiLayoutObservable} from './ui-layout.js';

/** Turns the latest stored value into the next one. */
export type ValueUpdate<Value> = (current: Readonly<Value>) => Value;

/** One of core's own pages of the Settings modal. Its tabs list in this order. */
export enum SettingsSection {
    General = 'general',
    Terminal = 'terminal',
    Sidebar = 'sidebar',
    Activities = 'activities',
    Ai = 'ai',
    Folders = 'folders',
    Forges = 'forges',
    Maintenance = 'maintenance',
}

/**
 * A page of the Settings modal that a plugin adds. `Details` is whatever the page's opener passes
 * through {@link createSettingsTarget}.
 */
export type SettingsSectionContribution<Details = undefined> = Readonly<{
    /** Prefixed by the owning plugin's id, so no two plugins' sections can collide. */
    id: string;
    label: string;
    group: string;
    /** Matched by the nav search, beside the section's label and its rows' text. */
    searchTerms: ReadonlyArray<string>;
    /** Titles the card of the section's schema settings, for a section with more cards. */
    schemaCardTitle: string | undefined;
    /** The settings shown as rows built from their schemas, in order. */
    schemaKeys: ReadonlyArray<SchemaSettingKey>;
    /** The core section whose tab this one follows. */
    listAfter: SettingsSection;
}> &
    PartialWithUndefined<{
        /** Replaces the section's schema rows. */
        render(
            params: Readonly<{
                settings: Readonly<Settings>;
                details: Details | undefined;
                changeSettings(update: ValueUpdate<Settings>): void;
            }>,
        ): HtmlInterpolation;
    }>;

/** Any settings section, as registries hold them. */
export type AnySettingsSectionContribution = SettingsSectionContribution<any>;

/** Types a plugin's settings section and prefixes its id with the plugin's. */
export function defineSettingsSection<Details = undefined>({
    pluginId,
    name,
    ...section
}: Readonly<
    Omit<SettingsSectionContribution<Details>, 'id'> & {
        pluginId: string;
        name: string;
    }
>): SettingsSectionContribution<Details> {
    return {
        ...section,
        id: `${pluginId}:${name}`,
    };
}

/**
 * Where the Settings modal is open: a core {@link SettingsSection}, or a plugin's section by its id.
 * An id with no section, like one from a plugin since turned off, opens the General section.
 */
export type SettingsTarget = Readonly<{
    section: string;
}> &
    PartialWithUndefined<{
        /** The folder the Folders section edits. */
        folder: string;
        /** Handed to the plugin section's `render`. */
        details: unknown;
    }>;

/** Opens a plugin's section with details its `render` reads. */
export function createSettingsTarget<Details>({
    section,
    details,
}: Readonly<{
    section: SettingsSectionContribution<Details>;
    details: Details | undefined;
}>) {
    return {
        section: section.id,
        details,
    } satisfies SettingsTarget;
}

/**
 * `vir-app`'s state, handed to every element below it. A new object on each `vir-app` render, so
 * elements given it re-render when any of its observables change.
 */
export type AppContext = Readonly<{
    screenSize: ScreenSize;
    folderData: FolderDataObservable;
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
    panes: ReadonlyArray<AnyPaneDefinition>;
    /** Every plugin's per-pane-group state, which each pane group runs. */
    paneGroupExtensions: ReadonlyArray<AnyPaneGroupExtension>;
    /** Every plugin's page of the Settings modal. */
    settingsSections: ReadonlyArray<AnySettingsSectionContribution>;
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
    'folderData' | 'paneRestarts' | 'uiLayout' | 'themeClient'
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
}>;

export type NewTabRequest = Readonly<{
    kind: string;
    /** Undefined on mobile, which has no groups of its own. */
    groupId: string | undefined;
    state?: Readonly<TabState> | undefined;
}>;

/** What a pane group's parent hands each extension, by the extension's id. */
export type PaneGroupExtensionInputs = Readonly<Record<string, unknown>>;

/** What a pane group knows about itself and hands to each tab's pane. */
export type PaneGroupView = Readonly<{
    folder: string;
    context: AppContext;
    /** True when the pane group is the user's currently focused folder. */
    isActive: boolean;
    isMobile: boolean;
    layout: Readonly<TabLayout>;
    extensionInputs: PaneGroupExtensionInputs;
    /**
     * Each extension's per-pane-group state, by the extension's id. Read it with
     * `findExtensionRun`.
     */
    extensionRuns: Readonly<Record<string, ObservableBase>>;
    writeLayout(change: (current: Readonly<TabLayout>) => Readonly<TabLayout>): void;
    openNewTab(params: NewTabRequest): Promise<void>;
    /** The session whose terminal grabs focus when it mounts. */
    sessionToFocus: string | undefined;
    focusedTabId: string | undefined;
}>;

/**
 * State a plugin keeps beside each pane group's tabs, for work that must run whether or not any of
 * the plugin's panes shows. A pane group re-renders when its `Run` changes and destroys it with the
 * group.
 */
export type PaneGroupExtension<
    Inputs = undefined,
    Run extends ObservableBase = ObservableBase,
> = Readonly<{
    /** Keys the extension's inputs and run on the pane group. */
    id: string;
    create(
        params: Readonly<{
            folder: string;
            context: AppContext;
            folderSessions: FolderSessionsObservable;
        }>,
    ): Run;
    /** Run from each pane group render, once its displayed tabs are known. */
    sync(
        params: Readonly<{
            run: Run;
            inputs: Inputs | undefined;
            view: PaneGroupView;
            displayedTabIds: ReadonlyArray<string>;
            /** The tabs that had been displayed before this render. */
            shownTabIds: ReadonlyArray<string>;
            /** Whether the folder's branch has a PR. */
            hasPr: boolean;
        }>,
    ): void;
}>;

/** Any pane group extension, as registries hold them. */
export type AnyPaneGroupExtension = PaneGroupExtension<any, any>;

/** The pane group's state for `extension`. */
export function findExtensionRun<Run extends ObservableBase>(
    {extensionRuns}: Readonly<Pick<PaneGroupView, 'extensionRuns'>>,
    extension: PaneGroupExtension<any, Run>,
) {
    return assertWrap.isDefined(extensionRuns[extension.id]) satisfies ObservableBase as Run;
}

/** What the pane group's parent passed `extension`, if anything. */
export function findExtensionInputs<Inputs>(
    {extensionInputs}: Readonly<Pick<PaneGroupView, 'extensionInputs'>>,
    extension: PaneGroupExtension<Inputs, any>,
) {
    return extensionInputs[extension.id] satisfies unknown as Inputs | undefined;
}

/** One tab's pane, as its definition renders it. */
export type PaneRenderParams<TabStateShape extends Shape = typeof noTabStateShape> = PaneGroupView &
    Readonly<{
        tabId: string;
        kind: string;
        /** The tab's own state, read through its pane's `tabStateShape`. */
        tabState: Readonly<TabStateShape['runtimeType']>;
        isDisplayed: boolean;
        /** Set for a session kind's tab, once its session exists. */
        sessionTab: SessionTab | undefined;
    }>;

/** One entry in the new-tab menu. */
export type NewTabEntry<TabStateShape extends Shape = typeof noTabStateShape> = Readonly<{
    label: string;
    /** The new tab's own state. */
    state: Readonly<Partial<TabStateShape['runtimeType']>> | undefined;
}>;

/** The `tabStateShape` of a pane whose tabs keep no state of their own. */
export const noTabStateShape = defineShape({});

/** Which end of its group a pane's default tab goes at. */
export enum DefaultTabPosition {
    Start = 'start',
    End = 'end',
}

/** Where a pane's tab goes in a folder's first layout. */
export type DefaultTabPlacement = Readonly<{
    /** The group holding this kind's sessions. */
    group: PaneKind;
    position: DefaultTabPosition;
}>;

/** One kind of pane a pane group's tab can hold. */
export type PaneDefinition<TabStateShape extends Shape = typeof noTabStateShape> = Readonly<{
    /** Stored as the kind of every tab showing the pane. */
    id: string;
    /**
     * Reads each tab's stored state. A key the shape doesn't accept is replaced by the shape's
     * default, so a stored value from an older version can't reach the pane.
     */
    tabStateShape: TabStateShape;
    /** Names a tab with no name of its own. */
    label(
        params: Readonly<{
            tabState: Readonly<TabStateShape['runtimeType']>;
            context: AppContext;
        }>,
    ): string;
    /** The kind's entries in the new-tab menu. */
    newTabEntries(view: PaneGroupView): ReadonlyArray<NewTabEntry<TabStateShape>>;
    icon: ViraIconSvg;
    /** Whether the pane runs an AI, which its tab shows and its menu can change. */
    hasAi: boolean;
    mounting: PaneMounting;
    isAvailable(view: PaneGroupView): boolean;
    render(params: PaneRenderParams<TabStateShape>): HtmlInterpolation;
}> &
    PartialWithUndefined<{
        /**
         * Where a folder's first layout puts a tab of this pane. Omitted or undefined, the layout
         * has none.
         */
        defaultPlacement(
            params: Readonly<Pick<PaneGroupView, 'extensionInputs'>>,
        ): DefaultTabPlacement | undefined;
    }>;

/** Any pane definition, as registries hold them. */
export type AnyPaneDefinition = PaneDefinition<any>;
