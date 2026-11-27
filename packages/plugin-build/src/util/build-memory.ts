import {
    defineFolderSetting,
    defineNumberSetting,
    defineSetting,
    sidebarWidth,
} from '@agent-storm/core/frontend';
import {check} from '@augment-vir/assert';
import {createArray} from '@augment-vir/common';
import {defineShape, enumShape, nullableShape} from 'object-shape-tester';
import {AiProvider, ReasoningEffort, RuntimeMode} from '../build-api.js';

/** Moves values kept under the plugin's legacy id, `build-v2`, to the keys below. */
function migrateLegacyKeys() {
    const legacyKeyPattern = /^agent-storm:build-v2(?=[:-])/;
    try {
        createArray(localStorage.length, (index) => localStorage.key(index))
            .filter(check.isString)
            .filter((key) => legacyKeyPattern.test(key))
            .forEach((key) => {
                const value = localStorage.getItem(key);
                if (value != undefined) {
                    localStorage.setItem(key.replace(legacyKeyPattern, 'agent-storm:build'), value);
                }
                localStorage.removeItem(key);
            });
    } catch {
        /** Storage can be unavailable, as in a private window, and then there's nothing to move. */
    }
}

migrateLegacyKeys();

/** The Build tab's memory, restored whenever the tab opens with nothing selected. */
export const buildMemory = {
    /** Same as the main sidebar's width setting, for the Build tab's sidebar. */
    sidebarWidth: defineNumberSetting({
        key: 'agent-storm:build-sidebar-width',
        bounds: sidebarWidth,
    }),
    /** Id of the last selected thread. */
    selectedThread: defineSetting<string | undefined>({
        key: 'agent-storm:build:selected-thread',
        defaultValue: undefined,
        parse(raw) {
            return raw || undefined;
        },
        serialize(value) {
            return value || undefined;
        },
    }),
    /** The project of the new-thread composer that was open, so a reload reopens it. */
    draftRepoPath: defineSetting<string | undefined>({
        key: 'agent-storm:build:draft-repo-path',
        defaultValue: undefined,
        parse(raw) {
            return raw || undefined;
        },
        serialize(value) {
            return value || undefined;
        },
    }),
    /** Each chat's unsent message, keyed by `toComposerDraftKey`. */
    composerDrafts: defineFolderSetting({
        key: 'agent-storm:build:composer-drafts',
        valueShape: '',
    }),
    /**
     * Each new chat's unsent title, model, runtime mode, and priority, keyed by
     * `toComposerDraftKey`.
     */
    newThreadSettings: defineFolderSetting({
        key: 'agent-storm:build:new-thread-settings',
        valueShape: defineShape({
            title: '',
            modelSelection: nullableShape(
                defineShape({
                    provider: enumShape(AiProvider),
                    model: '',
                    effort: nullableShape(enumShape(ReasoningEffort)),
                    speedTier: nullableShape(''),
                }),
            ),
            runtimeMode: enumShape(RuntimeMode),
            isPriority: false,
        }),
    }),
    /** The PR each thread last opened its Diff and Review tabs for, keyed by thread id. */
    reviewTabsPrUrl: defineFolderSetting({
        key: 'agent-storm:build:review-tabs-pr-url',
        valueShape: '',
    }),
    /** Each chat's uploaded attachments, keyed by `toComposerDraftKey`. */
    composerAttachments: defineFolderSetting({
        key: 'agent-storm:build:composer-attachments',
        valueShape: [
            defineShape({
                id: '',
                name: '',
                tag: '',
                path: '',
                imageUrl: nullableShape(''),
                textPreview: nullableShape(''),
            }),
        ],
    }),
};

/** A new chat's draft is kept per project, since it has no thread id yet. */
export function toComposerDraftKey({
    threadId,
    repoPath,
}: Readonly<{
    threadId: string | undefined;
    repoPath: string;
}>) {
    return threadId || `new:${repoPath}`;
}
