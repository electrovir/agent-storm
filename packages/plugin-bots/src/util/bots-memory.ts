import {defineNumberSetting, sidebarWidth} from '@agent-storm/core/frontend';

/** The Bots tab's memory. */
export const botsMemory = {
    /** Same as the main sidebar's width setting, for the Bots tab's sidebar. */
    sidebarWidth: defineNumberSetting({
        key: 'agent-storm:bots-sidebar-width',
        bounds: sidebarWidth,
    }),
};
