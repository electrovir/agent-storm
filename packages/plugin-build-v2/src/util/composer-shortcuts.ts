import {defineShortcutAction, KeyboardPlatform} from '@agent-storm/core/frontend';
import {buildV2PluginId} from '../build-v2-api.js';

/** The chat composer's shortcut actions. Each works while focus is inside the composer. */
export const composerShortcutActions = {
    send: defineShortcutAction({
        pluginId: buildV2PluginId,
        name: 'send',
        label: 'Send message',
        description: 'Sends the message typed in a chat.',
        defaults: {
            [KeyboardPlatform.Mac]: [
                {
                    code: 'Enter',
                },
            ],
            [KeyboardPlatform.Other]: [
                {
                    code: 'Enter',
                },
            ],
        },
    }),
    sendInWorktree: defineShortcutAction({
        pluginId: buildV2PluginId,
        name: 'send-in-worktree',
        label: 'Send in a new worktree',
        description:
            "Opens a new worktree and sends a new chat's message from it. In a chat without that option, it sends the message normally.",
        defaults: {
            [KeyboardPlatform.Mac]: [
                {
                    code: 'Enter',
                    metaKey: true,
                },
            ],
            [KeyboardPlatform.Other]: [
                {
                    code: 'Enter',
                    ctrlKey: true,
                },
            ],
        },
    }),
    interrupt: defineShortcutAction({
        pluginId: buildV2PluginId,
        name: 'interrupt',
        label: 'Interrupt chat',
        description: 'Stops the running chat being typed in.',
        defaults: {
            [KeyboardPlatform.Mac]: [
                {
                    code: 'Escape',
                },
            ],
            [KeyboardPlatform.Other]: [
                {
                    code: 'Escape',
                },
            ],
        },
    }),
    archive: defineShortcutAction({
        pluginId: buildV2PluginId,
        name: 'archive',
        label: 'Archive thread',
        description: 'Archives the chat being typed in.',
        defaults: {
            [KeyboardPlatform.Mac]: [
                {
                    code: 'KeyA',
                    metaKey: true,
                    ctrlKey: true,
                },
            ],
            [KeyboardPlatform.Other]: [
                {
                    code: 'KeyA',
                    ctrlKey: true,
                    altKey: true,
                },
            ],
        },
    }),
};
