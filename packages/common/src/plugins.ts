import {defineShape, enumShape, nullableShape, optionalShape} from 'object-shape-tester';

/**
 * The file at the top of every plugin's folder, built-in or external. The app reads it to list the
 * plugin before any of the plugin's code is allowed to run.
 */
export const pluginManifestFileName = 'agent-storm-plugin.json';

/** A pane a plugin adds, as its manifest lists it. */
export const pluginPaneContributionShape = defineShape({
    id: '',
    label: '',
    /**
     * The name vira exports the pane's icon under, such as `LucideEyeIcon`. Shown on the pane's
     * tabs until the plugin loads.
     */
    icon: optionalShape('', {
        alsoUndefined: true,
    }),
});

export type PluginPaneContribution = typeof pluginPaneContributionShape.runtimeType;

/** An activity a plugin adds, as its manifest lists it. */
export const pluginActivityContributionShape = defineShape({
    id: '',
    label: '',
    /** The same as the activity's own `isEnabledByDefault`, which the plugin must match. */
    isEnabledByDefault: false,
    /**
     * Loads the plugin as soon as the window opens instead of when one of its tabs is first shown.
     * Set exactly when the activity has a `startWithApp` or `findCount`, which otherwise don't run
     * until then. The plugin fails to load when this doesn't match.
     */
    isStartedWithApp: optionalShape(false, {
        alsoUndefined: true,
    }),
});

export type PluginActivityContribution = typeof pluginActivityContributionShape.runtimeType;

/** The contents of a plugin's {@link pluginManifestFileName}. */
export const pluginManifestShape = defineShape({
    id: '',
    name: '',
    description: '',
    /**
     * The plugin's browser code: one ES module whose default export is its `definePlugin` value.
     * Relative to the manifest's folder, and can't leave it.
     */
    browserEntry: '',
    /**
     * The plugin's server code: one ES module whose default export is its `definePluginServer`
     * value. Relative to the manifest's folder, and can't leave it. Omitted for a plugin with no
     * server part.
     */
    serverEntry: optionalShape('', {
        alsoUndefined: true,
    }),
    /** Marks a plugin that isn't finished yet, which the Settings modal tags as beta. */
    isBeta: optionalShape(false, {
        alsoUndefined: true,
    }),
    /**
     * The ids of the plugins whose modules this plugin imports. It runs only while all of them run,
     * and its imports of their packages read their already loaded modules.
     */
    dependencies: optionalShape([''], {
        alsoUndefined: true,
    }),
    /**
     * The ids of plugins whose server `exports` this plugin uses when they run. Unlike
     * `dependencies`, it runs without them.
     */
    optionalDependencies: optionalShape([''], {
        alsoUndefined: true,
    }),
    /**
     * The `@agent-storm/core` versions the plugin works with, as an npm semver range. Required, so
     * a plugin that doesn't say what it works with never runs on a guess. A plugin whose range
     * excludes the running core version doesn't run.
     */
    coreVersionRange: '',
    /** Every pane the plugin adds. Shown, disabled, while the plugin waits on approval. */
    panes: [pluginPaneContributionShape],
    /** Every activity the plugin adds. Shown, disabled, while the plugin waits on approval. */
    activities: [pluginActivityContributionShape],
});

export type PluginManifest = typeof pluginManifestShape.runtimeType;

/** What the user chose for a plugin. */
export enum PluginDecision {
    /** Runs the plugin's files as they were when approved, and no other version of them. */
    Approved = 'approved',
    /**
     * Runs whatever the plugin's files hold, for a plugin symlinked in from where it's being
     * written. Only a symlinked plugin can be trusted this way.
     */
    TrustedWhileDeveloping = 'trustedWhileDeveloping',
    Blocked = 'blocked',
}

/** One stored {@link PluginDecision}, keyed by plugin id. */
export const pluginDecisionRecordShape = defineShape({
    pluginId: '',
    decision: enumShape(PluginDecision),
    /** The approved version's {@link pluginEntryShape} `contentHash`. Empty for other decisions. */
    contentHash: '',
});

export type PluginDecisionRecord = typeof pluginDecisionRecordShape.runtimeType;

/** Whether a plugin runs, and why not. */
export enum PluginStatus {
    Active = 'active',
    /** An external plugin never approved or blocked. */
    NeedsApproval = 'needsApproval',
    /** A built-in plugin that isn't on by default and was never turned on. */
    Disabled = 'disabled',
    /** Approved, but its files changed since, so it waits on approval again. */
    Changed = 'changed',
    Blocked = 'blocked',
    /** Its manifest or code can't be read, or its id is taken. */
    Invalid = 'invalid',
    /** Its manifest's `coreVersionRange` excludes the `@agent-storm/core` version the app runs. */
    IncompatibleCore = 'incompatibleCore',
    /** One of its manifest's `dependencies` isn't running. */
    MissingDependency = 'missingDependency',
}

/**
 * One plugin: a built-in one shipped inside the app, or a folder (or symlink to a folder) in the
 * plugins folder.
 */
export const pluginEntryShape = defineShape({
    /** The manifest's id, or the folder's name when the manifest can't be read. */
    id: '',
    /**
     * Shipped inside the app, so trusted without approving its files. It still runs only while
     * turned on.
     */
    isBuiltIn: false,
    /** Its folder's name, inside the plugins folder for an external plugin. */
    folderName: '',
    /** Where its files really are. Differs from the plugins folder when it's a symlink. */
    realPath: '',
    isSymlink: false,
    /** The `origin` remote of the git repo holding its files. Empty when there's none. */
    gitRemote: '',
    /**
     * A hash of the manifest and the browser and server entries together. Empty when any can't be
     * read.
     */
    contentHash: '',
    manifest: nullableShape(pluginManifestShape),
    /** Why the plugin is {@link PluginStatus.Invalid}. */
    problem: '',
    status: enumShape(PluginStatus),
});

export type PluginEntry = typeof pluginEntryShape.runtimeType;

/** A running plugin that a version of the app would stop, because of its core version range. */
export const pluginTurnedOffShape = defineShape({
    pluginId: '',
    name: '',
    coreVersionRange: '',
});

export type PluginTurnedOff = typeof pluginTurnedOffShape.runtimeType;

/**
 * Every plugin and every stored decision. Built-in plugins list first, in the order their
 * activities and panes list in.
 */
export const pluginsResponseShape = defineShape({
    /** The `@agent-storm/core` version the running app supplies to plugins. */
    coreVersion: '',
    /** Where external plugins go: each folder, or symlink to one, in here is a plugin. */
    pluginsDir: '',
    plugins: [pluginEntryShape],
    decisions: [pluginDecisionRecordShape],
});

/** Whether a folder's settings file applies in full. */
export enum FolderSettingsApproval {
    /** Nothing in the file runs commands or code, so it applies without approval. */
    NotNeeded = 'notNeeded',
    NeedsApproval = 'needsApproval',
    /** Approved, but its text changed since, so it waits on approval again. */
    Changed = 'changed',
    Approved = 'approved',
}

/** One folder settings file the user approved, as its text was then. */
export const approvedFolderSettingsShape = defineShape({
    path: '',
    contentHash: '',
});

/**
 * Names the `exports` a plugin's server part returns, for its dependents' `waitForPlugin`. Lives
 * apart from the server part, so a dependent imports the key without bundling the dependency's
 * server code.
 */
export type PluginServerExportsKey<Exports> = Readonly<{
    pluginId: string;
    /** Never set: only carries the exports' type. */
    exportsType?: Exports | undefined;
}>;

/** Creates the key that types a plugin's server `exports` for the plugins that depend on it. */
export function definePluginServerExportsKey<const Exports>(
    pluginId: string,
): PluginServerExportsKey<Exports> {
    return {
        pluginId,
    };
}
