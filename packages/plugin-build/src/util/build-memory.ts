import {defineSetting} from '@agent-storm/core/frontend';

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
};
