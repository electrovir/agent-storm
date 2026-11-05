import {type Observable} from 'element-vir';
import {type ViraThemeClient} from 'vira';
import {type resolveAppRoute} from './app-route.js';
import {type FolderDataObservable} from './folder-data.js';
import {type FrontendStateObservable, type PrQueueKind} from './frontend-state.js';
import {type PaneRestartsObservable} from './pane-restarts.js';
import {type AppRoute} from './router.js';
import {type ScreenSize} from './screen-size.js';

export enum AppModal {
    Settings = 'settings',
    /** The "Define AI" modal, raised from the settings modal so the two never stack. */
    Ai = 'ai',
}

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
    isDebugTabShown: boolean;
    paneRestarts: PaneRestartsObservable;
    openModal: Observable<AppModal | undefined>;
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
