import {defineNumberSetting, defineSetting, sidebarWidth} from '@agent-storm/core/frontend';

/** The Build V2 tab's memory, restored whenever the tab opens with nothing selected. */
export const buildV2Memory = {
    /** Same as the main sidebar's width setting, for the Build V2 tab's sidebar. */
    sidebarWidth: defineNumberSetting({
        key: 'agent-storm:build-v2-sidebar-width',
        bounds: sidebarWidth,
    }),
    /** Id of the last selected thread. */
    selectedThread: defineSetting<string | undefined>({
        key: 'agent-storm:build-v2:selected-thread',
        defaultValue: undefined,
        parse(raw) {
            return raw || undefined;
        },
        serialize(value) {
            return value || undefined;
        },
    }),
};
