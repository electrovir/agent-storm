import {
    defineNumberSetting,
    defineRememberedSelection,
    sidebarWidth,
} from '@agent-storm/core/frontend';

/** The Bots tab's memory. */
export const botsMemory = {
    /** Same as the main sidebar's width setting, for the Bots tab's sidebar. */
    sidebarWidth: defineNumberSetting({
        key: 'agent-storm:bots-sidebar-width',
        bounds: sidebarWidth,
    }),
    /** Id of the last selected bot, or of the repo whose config was selected. */
    selectedTarget: defineRememberedSelection('agent-storm:bots:selected-target'),
};
