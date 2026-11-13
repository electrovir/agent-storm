import {defineSetting} from '@agent-storm/core/frontend';
import {check} from '@augment-vir/assert';

/** The Build tab's memory, restored whenever the tab opens with nothing selected. */
export const buildMemory = {
    /** Absolute path of the last selected folder. */
    selectedFolder: defineSetting<string | undefined>({
        key: 'agent-storm:build:selected-folder',
        defaultValue: undefined,
        parse(raw) {
            return raw || undefined;
        },
        serialize(value) {
            return value || undefined;
        },
    }),
    /**
     * Absolute paths of the folders whose panes were mounted, least recently active first, so they
     * mount again after a relaunch.
     */
    openedFolders: defineSetting<ReadonlyArray<string>>({
        key: 'agent-storm:build:opened-folders',
        defaultValue: [],
        parse(raw) {
            const parsed: unknown = JSON.parse(raw);
            return check.isArray(parsed) ? parsed.filter(check.isString) : [];
        },
        serialize(value) {
            return value.length ? JSON.stringify(value) : undefined;
        },
    }),
};
