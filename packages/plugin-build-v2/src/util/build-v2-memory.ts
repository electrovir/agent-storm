import {
    defineFolderSetting,
    defineNumberSetting,
    defineSetting,
    sidebarWidth,
} from '@agent-storm/core/frontend';
import {defineShape, nullableShape} from 'object-shape-tester';

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
    /** The project of the new-thread composer that was open, so a reload reopens it. */
    draftRepoPath: defineSetting<string | undefined>({
        key: 'agent-storm:build-v2:draft-repo-path',
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
        key: 'agent-storm:build-v2:composer-drafts',
        valueShape: '',
    }),
    /** Each chat's uploaded attachments, keyed by `toComposerDraftKey`. */
    composerAttachments: defineFolderSetting({
        key: 'agent-storm:build-v2:composer-attachments',
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
