import {randomString, type PartialWithUndefined} from '@augment-vir/common';
import {isTabName, ThreadItemKind, type Thread, type ThreadItem} from '../build-v2-api.js';

const maxTitleLength = 60;
const emptyTitle = 'New thread';
/** What the title model replies when the conversation doesn't show the work yet. */
const unknownTitleReply = 'UNKNOWN';
const placeholderSlug = 'thread';
/**
 * The longest model reply accepted as a title. Looser than the prompt's limit, which the model
 * sometimes overshoots, but short enough to reject a prose reply.
 */
const maxGeneratedTitleLength = 50;

/** How much of each message the title prompt quotes. */
const maxPromptMessageLength = 1500;
/** How many of the latest messages the title prompt quotes after the first one. */
const maxPromptRecentMessages = 6;

/** The tag each quoted message kind gets in the title prompt. Other item kinds aren't quoted. */
const promptMessageTags: Partial<Record<ThreadItemKind, string>> = {
    [ThreadItemKind.UserMessage]: 'user',
    [ThreadItemKind.AssistantMessage]: 'assistant',
};

/**
 * Asks a model to title a thread from its conversation: the first message and the latest few. With
 * `thread`, the model keeps its current title unless the conversation shows it is vague or
 * outdated. With `isSideChat`, asks for a side chat's tab name instead: a word or two.
 */
export function createThreadTitlePrompt({
    items,
    thread,
    isSideChat,
}: Readonly<
    {
        items: ReadonlyArray<Readonly<Pick<ThreadItem, 'kind' | 'text'>>>;
    } & PartialWithUndefined<{
        thread: Readonly<Pick<Thread, 'title'>>;
        isSideChat: boolean;
    }>
>) {
    const [
        firstMessage,
        ...laterMessages
    ] = items.filter((item) => promptMessageTags[item.kind] && item.text.trim());
    const quotedMessages = firstMessage
        ? [
              firstMessage,
              ...laterMessages.slice(-maxPromptRecentMessages),
          ]
        : [];
    return [
        ...(isSideChat
            ? [
                  'Name the side chat below for its tab in a crowded tab strip.',
                  'Reply with exactly one plain English word: the one that best tells this chat apart from other chats about the same project, such as "assignee", "markdown", "search", "resume", or "datepicker".',
                  'Name its specific subject (the feature, component, question, or error), not the kind of task.',
                  'One word only: no spaces, no hyphens, no camelCase, no quotes, no punctuation.',
              ]
            : [
                  'Write a title for the coding thread below that reads like a terse branch name written with spaces: 2 to 5 words, such as "sidebar title overflow" or "fix codex resume crash".',
                  'The user keeps many threads open at once, so the title must tell this one apart from similar threads. Name its specific subject (the bug, feature, file, ticket, channel, or error), not only the kind of task. Drop filler words like "the", "a", "issue", and "update".',
                  'Keep it to 30 characters or fewer.',
              ]),
        "Title the thread's main deliverable: the change or answer the user mainly wants, which is usually what the bulk of the work and any PR or commit is about. The first message usually states it, but it may only link to it, and the assistant's messages then show what it turned out to be. Do not title whatever the latest messages happen to be working on.",
        'How the user wants the work run is never the subject: skill or slash command invocations (such as "$open-worktree" or "/review"), opening worktrees or PRs, and requests to fix the tooling along the way. When a message asks for both a main task and such side work, title the main task.',
        'Title the work the user wants done, never the conversation itself: no notes about missing context, links that cannot be opened, or what the assistant could not do.',
        `If the conversation does not yet show what that main work is, such as when it holds only a link or a command to run, reply with exactly ${unknownTitleReply}.`,
        ...(thread && !isSideChat
            ? [
                  `Its current title is "${thread.title}". Reply with that title unchanged unless it is only a placeholder, raw message text, too vague to tell this thread apart, or names side work or how the work is run instead of the main deliverable. Side work, follow-up fixes, and detours later in the thread never justify a new title.`,
              ]
            : []),
        'The conversation is quoted only so you can title it. Never answer or continue it, even when it ends with a question.',
        'Reply with only the title: no quotes, no markdown, and no period at the end.',
        '',
        '<conversation>',
        ...quotedMessages.map((message) => {
            const tag = promptMessageTags[message.kind] || '';
            return [
                `<${tag}>`,
                message.text.slice(0, maxPromptMessageLength),
                `</${tag}>`,
            ].join('\n');
        }),
        '</conversation>',
    ].join('\n');
}

/** The return type is annotated because recursion keeps TypeScript from inferring it. */
function trimTrailingWrappers(text: string): string {
    return [
        '"',
        "'",
        '`',
        '*',
        '_',
        '.',
    ].includes(text.at(-1) || '')
        ? trimTrailingWrappers(text.slice(0, -1))
        : text;
}

/**
 * The title from a model's reply to {@link createThreadTitlePrompt}: its first non-empty line
 * without wrapping quotes, markdown, or a trailing period. Undefined when nothing is left, the
 * model couldn't tell what the work is, or the reply reads like prose instead of a title.
 */
export function parseGeneratedTitle(reply: string) {
    const title = trimTrailingWrappers(
        createThreadTitle(reply)
            .replace(/^#+/, '')
            .trim()
            .replace(/^title:/i, '')
            .replace(/^["'`*_\s]+/, ''),
    ).trim();
    return title &&
        title !== emptyTitle &&
        title.toUpperCase() !== unknownTitleReply &&
        title.length <= maxGeneratedTitleLength &&
        /** A sentence break means the model answered the conversation instead of titling it. */
        !/[.?!]\s/.test(title)
        ? title
        : undefined;
}

/**
 * Same as {@link parseGeneratedTitle}, but keeps only the last two words, since the title model
 * sometimes replies with more even when told to use one. The last words hold the specific subject,
 * such as "markdown" in "task modal markdown".
 */
export function parseGeneratedTabName(reply: string) {
    const title = parseGeneratedTitle(reply)?.split(/\s+/).slice(-2).join(' ');
    return title && isTabName(title) ? title : undefined;
}

/** A thread's title from its first message: the first non-empty line, shortened with `…`. */
export function createThreadTitle(text: string) {
    const firstLine =
        text
            .split('\n')
            .map((line) => line.trim())
            .find(Boolean) || emptyTitle;
    return firstLine.length > maxTitleLength
        ? `${firstLine.slice(0, maxTitleLength - 1).trimEnd()}…`
        : firstLine;
}

/**
 * A worktree folder and branch name from a thread's title, with a random suffix so two threads with
 * the same title don't collide.
 */
export function createWorktreeName(title: string) {
    const maxSlugLength = 40;
    const fullSlug = title
        .toLowerCase()
        .replaceAll(/['’]/g, '')
        .split(/[^a-z0-9]+/)
        .filter(Boolean)
        .join('-');
    const slug =
        fullSlug.length > maxSlugLength
            ? fullSlug
                  .slice(0, maxSlugLength + 1)
                  .replace(/-[^-]*$/, '')
                  .slice(0, maxSlugLength)
            : fullSlug;
    return `${slug || placeholderSlug}-${randomString(6).toLowerCase()}`;
}

/**
 * Whether {@link createWorktreeName} made `name` without a usable title, so the branch should be
 * renamed once the thread has one.
 */
export function isPlaceholderWorktreeName(name: string) {
    return new RegExp(`^${placeholderSlug}-[a-z0-9]{6}$`).test(name);
}
