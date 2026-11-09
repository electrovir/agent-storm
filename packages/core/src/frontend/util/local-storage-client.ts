import {
    folderInfoShape,
    GitDiffSide,
    savedRepoShape,
    settingsShape,
    tabSelectionShape,
} from '@agent-storm/common';
import {clamp, omitObjectKeys, type PartialWithUndefined} from '@augment-vir/common';
import {
    checkValidShape,
    defineShape,
    enumShape,
    exactShape,
    recordShape,
    unionShape,
    type ShapeInitType,
} from 'object-shape-tester';

type Listener<T> = (value: T) => void;

export type SettingConfig<T> = {
    key: string;
    defaultValue: T;
    parse: (raw: string) => T;
    serialize: (value: T) => string | undefined;
};

export type Setting<T> = {
    readonly key: string;
    read(): T;
    write(value: T): void;
    clear(): void;
    subscribe(fn: Listener<T>): () => void;
};

export function defineSetting<T>(config: SettingConfig<T>): Setting<T> {
    const listeners = new Set<Listener<T>>();
    function notify(value: T) {
        listeners.forEach((fn) => fn(value));
    }
    return {
        key: config.key,
        read() {
            try {
                const raw = globalThis.localStorage.getItem(config.key);
                if (raw == undefined) {
                    return config.defaultValue;
                }
                return config.parse(raw);
            } catch {
                // localStorage may throw in private mode / sandboxed contexts.
                return config.defaultValue;
            }
        },
        write(value) {
            try {
                const serialized = config.serialize(value);
                if (serialized == undefined) {
                    globalThis.localStorage.removeItem(config.key);
                } else {
                    globalThis.localStorage.setItem(config.key, serialized);
                }
            } catch {
                // localStorage may throw in private mode / sandboxed contexts.
            }
            notify(value);
        },
        clear() {
            try {
                globalThis.localStorage.removeItem(config.key);
            } catch {
                // localStorage may throw in private mode / sandboxed contexts.
            }
            notify(config.defaultValue);
        },
        subscribe(fn) {
            listeners.add(fn);
            return () => {
                listeners.delete(fn);
            };
        },
    };
}

const sidebarSnapshotShape = defineShape({
    folders: [
        folderInfoShape,
    ],
    repos: [
        savedRepoShape,
    ],
    settings: settingsShape,
});

export type SidebarSnapshot = typeof sidebarSnapshotShape.runtimeType;

export const sidebarWidth = {
    min: 180,
    max: 600,
    default: 280,
} as const;

export const diffSidebarWidth = {
    min: 140,
    max: 700,
    default: 260,
} as const;

export const scrollbackLimit = {
    min: 100,
    max: 100_000,
    default: 20_000,
} as const;

type NumberBounds = Readonly<{
    min: number;
    max: number;
    default: number;
}>;

/** A number setting clamped into `bounds`, falling back to the default when it isn't a number. */
function defineNumberSetting({
    key,
    bounds,
    isInteger,
}: Readonly<{
    key: string;
    bounds: NumberBounds;
}> &
    PartialWithUndefined<{
        isInteger: boolean;
    }>) {
    return defineSetting<number>({
        key,
        defaultValue: bounds.default,
        parse(raw) {
            const value = isInteger ? Math.round(Number.parseFloat(raw)) : Number.parseFloat(raw);
            return Number.isFinite(value) ? clamp(value, bounds) : bounds.default;
        },
        serialize(value) {
            return String(value);
        },
    });
}

export type FolderSetting<Value> = Setting<Partial<Record<string, Value>>> & {
    readFolder(folder: string): Value | undefined;
    /** `undefined` removes the folder's entry. */
    writeFolder(
        params: Readonly<{
            folder: string;
            value: Value | undefined;
        }>,
    ): void;
};

/**
 * One value per folder, keyed by absolute folder path. A stored map that doesn't match `valueShape`
 * is discarded on read, so a hand-edited or stale value falls back to the caller's default rather
 * than being trusted.
 */
function defineFolderSetting<const ValueShape>({
    key,
    valueShape,
}: Readonly<{
    key: string;
    valueShape: ValueShape;
}>): FolderSetting<ShapeInitType<ValueShape>> {
    const mapShape = recordShape({
        keys: '',
        values: valueShape,
        partial: true,
    });
    const setting = defineSetting<Partial<Record<string, ShapeInitType<ValueShape>>>>({
        key,
        defaultValue: {},
        parse(raw) {
            const parsed: unknown = JSON.parse(raw);
            return checkValidShape(parsed, mapShape) ? parsed : {};
        },
        serialize(value) {
            return JSON.stringify(value);
        },
    });
    return {
        ...setting,
        readFolder(folder) {
            return setting.read()[folder];
        },
        writeFolder({folder, value}) {
            setting.write(
                value == undefined
                    ? omitObjectKeys(setting.read(), [
                          folder,
                      ])
                    : {
                          ...setting.read(),
                          [folder]: value,
                      },
            );
        },
    };
}

export const localStorageClient = {
    authSecret: defineSetting<string | undefined>({
        key: 'agent-storm-auth-secret',
        defaultValue: undefined,
        parse(raw) {
            return raw || undefined;
        },
        serialize(value) {
            return value || undefined;
        },
    }),
    sidebarWidth: defineNumberSetting({
        key: 'agent-storm:sidebar-width',
        bounds: sidebarWidth,
    }),
    /** Same as `sidebarWidth`, for the Review tab's sidebar. */
    reviewSidebarWidth: defineNumberSetting({
        key: 'agent-storm:review-sidebar-width',
        bounds: sidebarWidth,
    }),
    diffSidebarWidth: defineNumberSetting({
        key: 'agent-storm:diff-sidebar-width',
        bounds: diffSidebarWidth,
    }),
    /**
     * Which file each folder's diff pane was last showing, as that pane's own side-plus-path select
     * value. A value naming a file that no longer has a diff is discarded when the pane next reads
     * git status.
     */
    diffFileByFolder: defineFolderSetting({
        key: 'agent-storm:diff-file-by-folder',
        valueShape: '',
    }),
    /**
     * Which side each folder's diff pane was last reading as one stacked review, or `false` for a
     * folder that was last on a single-file diff. A folder with no entry opens the unstaged
     * review.
     */
    diffReviewSideByFolder: defineFolderSetting({
        key: 'agent-storm:diff-review-side-by-folder',
        valueShape: unionShape(enumShape(GitDiffSide), exactShape(false)),
    }),
    /**
     * The tab selection the last window to change one had in each folder, which a newly opened
     * window starts from.
     */
    tabSelectionByFolder: defineFolderSetting({
        key: 'agent-storm:tab-selection-by-folder',
        valueShape: tabSelectionShape,
    }),
    /**
     * The repos sidebar's last loaded data. A page reload (which the backend watchdog triggers
     * after any backend outage) renders this right away instead of an empty list.
     */
    sidebarSnapshot: defineSetting<SidebarSnapshot | undefined>({
        key: 'agent-storm:sidebar-snapshot',
        defaultValue: undefined,
        parse(raw) {
            const parsed: unknown = JSON.parse(raw);
            return checkValidShape(parsed, sidebarSnapshotShape) ? parsed : undefined;
        },
        serialize(value) {
            return value && JSON.stringify(value);
        },
    }),
    scrollbackLimit: defineNumberSetting({
        key: 'agent-storm:scrollback-limit',
        bounds: scrollbackLimit,
        isInteger: true,
    }),
};
