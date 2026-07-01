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
    const notify = (value: T) => {
        listeners.forEach((fn) => fn(value));
    };
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

export const paneSplit = {
    min: 0.1,
    max: 0.9,
    default: 0.5,
} as const;

function clamp(value: number, min: number, max: number, fallback: number): number {
    if (!Number.isFinite(value)) {
        return fallback;
    }
    return Math.min(max, Math.max(min, value));
}

export const localStorageClient = {
    authSecret: defineSetting<string | undefined>({
        key: 'agent-storm-auth-secret',
        defaultValue: undefined,
        parse: (raw) => raw || undefined,
        serialize: (value) => value || undefined,
    }),
    sidebarWidth: defineSetting<number>({
        key: 'agent-storm:sidebar-width',
        defaultValue: sidebarWidth.default,
        parse: (raw) =>
            clamp(Number.parseFloat(raw), sidebarWidth.min, sidebarWidth.max, sidebarWidth.default),
        serialize: (value) => String(value),
    }),
    paneSplit: defineSetting<number>({
        key: 'agent-storm:pane-split',
        defaultValue: paneSplit.default,
        parse: (raw) =>
            clamp(Number.parseFloat(raw), paneSplit.min, paneSplit.max, paneSplit.default),
        serialize: (value) => String(value),
    }),
    /**
     * Whether the sidebar's "Working" group is collapsed. Defaults to expanded so first-time
     * users see everything; persists per-browser so a closed list stays closed across reloads.
     */
    workingGroupCollapsed: defineSetting<boolean>({
        key: 'agent-storm:sidebar-working-collapsed',
        defaultValue: false,
        parse: (raw) => raw === 'true',
        serialize: (value) => String(value),
    }),
};
