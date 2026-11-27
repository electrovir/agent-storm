import {defineShortcutAction, KeyboardPlatform} from '@agent-storm/core/frontend';
import {buildPluginId} from '../build-api.js';

/** The chat composer's shortcut actions. Each works while focus is inside the composer. */
export const composerShortcutActions = {
    send: defineShortcutAction({
        pluginId: buildPluginId,
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
        pluginId: buildPluginId,
        name: 'send-in-worktree',
        label: 'Send in a new worktree',
        description:
            "Opens a new worktree and sends a new chat's message from it. In a chat without that option, it sends the message normally.",
        defaults: {
            [KeyboardPlatform.Mac]: [
                {
                    code: 'Enter',
                    altKey: true,
                },
            ],
            [KeyboardPlatform.Other]: [
                {
                    code: 'Enter',
                    altKey: true,
                },
            ],
        },
    }),
    interrupt: defineShortcutAction({
        pluginId: buildPluginId,
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
        pluginId: buildPluginId,
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
