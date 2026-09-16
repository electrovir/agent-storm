type Listener<T> = (value: T) => void;

type SettingConfig<T> = {
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

function defineSetting<T>(config: SettingConfig<T>): Setting<T> {
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

export const paneSplit = {
    min: 0.1,
    max: 0.9,
    default: 0.5,
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

function clamp({
    value,
    bounds,
}: Readonly<{
    value: number;
    bounds: NumberBounds;
}>) {
    if (!Number.isFinite(value)) {
        return bounds.default;
    }
    return Math.min(bounds.max, Math.max(bounds.min, value));
}

/**
 * A string per folder, keyed by absolute folder path. Non-string entries are dropped on read, so a
 * hand-edited or stale value falls back to the caller's default rather than being trusted.
 */
function parseStringByFolder(raw: string): Record<string, string> {
    try {
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return {};
        }
        return Object.fromEntries(
            Object.entries(parsed).filter(
                ([
                    ,
                    value,
                ]) => typeof value === 'string',
            ),
        ) as Record<string, string>;
    } catch {
        return {};
    }
}

/**
 * Which session tab each folder was last on, per pane kind: `{'/path/to/repo': {ai: 2, shell: 1}}`.
 * 1-based, matching the URL params. Entries that aren't a positive integer are dropped on read, so
 * a hand-edited or stale value falls back to the first session rather than pointing at nothing.
 */
function parseSessionIndexByFolder(raw: string): Record<string, Record<string, number>> {
    try {
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return {};
        }
        return Object.fromEntries(
            Object.entries(parsed).flatMap(
                ([
                    folder,
                    byKind,
                ]) => {
                    if (!byKind || typeof byKind !== 'object' || Array.isArray(byKind)) {
                        return [];
                    }
                    const validIndexes = Object.fromEntries(
                        Object.entries(byKind).filter(
                            ([
                                ,
                                index,
                            ]) => Number.isSafeInteger(index) && Number(index) >= 1,
                        ),
                    ) as Record<string, number>;
                    return Object.keys(validIndexes).length
                        ? [
                              [
                                  folder,
                                  validIndexes,
                              ] as const,
                          ]
                        : [];
                },
            ),
        );
    } catch {
        return {};
    }
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
    sidebarWidth: defineSetting<number>({
        key: 'agent-storm:sidebar-width',
        defaultValue: sidebarWidth.default,
        parse(raw) {
            return clamp({
                value: Number.parseFloat(raw),
                bounds: sidebarWidth,
            });
        },
        serialize(value) {
            return String(value);
        },
    }),
    diffSidebarWidth: defineSetting<number>({
        key: 'agent-storm:diff-sidebar-width',
        defaultValue: diffSidebarWidth.default,
        parse(raw) {
            return clamp({
                value: Number.parseFloat(raw),
                bounds: diffSidebarWidth,
            });
        },
        serialize(value) {
            return String(value);
        },
    }),
    paneSplit: defineSetting<number>({
        key: 'agent-storm:pane-split',
        defaultValue: paneSplit.default,
        parse(raw) {
            return clamp({
                value: Number.parseFloat(raw),
                bounds: paneSplit,
            });
        },
        serialize(value) {
            return String(value);
        },
    }),
    /**
     * Which tab each folder was last on. Persisted so switching away from a folder and back returns
     * to the pane you were using there, rather than resetting to AI.
     */
    tabByFolder: defineSetting<Record<string, string>>({
        key: 'agent-storm:tab-by-folder',
        defaultValue: {},
        parse: parseStringByFolder,
        serialize(value) {
            return JSON.stringify(value);
        },
    }),
    /**
     * Which file each folder's diff pane was last showing, as that pane's own side-plus-path select
     * value. A value naming a file that no longer has a diff is discarded when the pane next reads
     * git status.
     */
    diffFileByFolder: defineSetting<Record<string, string>>({
        key: 'agent-storm:diff-file-by-folder',
        defaultValue: {},
        parse: parseStringByFolder,
        serialize(value) {
            return JSON.stringify(value);
        },
    }),
    sessionIndexByFolder: defineSetting<Record<string, Record<string, number>>>({
        key: 'agent-storm:session-index-by-folder',
        defaultValue: {},
        parse: parseSessionIndexByFolder,
        serialize(value) {
            return JSON.stringify(value);
        },
    }),
    scrollbackLimit: defineSetting<number>({
        key: 'agent-storm:scrollback-limit',
        defaultValue: scrollbackLimit.default,
        parse(raw) {
            return clamp({
                value: Math.round(Number.parseFloat(raw)),
                bounds: scrollbackLimit,
            });
        },
        serialize(value) {
            return String(value);
        },
    }),
};
