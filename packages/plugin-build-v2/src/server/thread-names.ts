import {randomString} from '@augment-vir/common';

const maxTitleLength = 60;
const emptyTitle = 'New thread';

/** How much of the first message the title prompt quotes. */
const maxPromptMessageLength = 2000;

/** Asks a model to title a thread from its first message. */
export function createThreadTitlePrompt(text: string) {
    return [
        'Write a short title for a coding thread that starts with the message below.',
        'Keep it to 30 characters or fewer. Go longer only if no shorter title would make sense.',
        'Reply with only the title: no quotes, no markdown, and no period at the end.',
        '',
        '<message>',
        text.slice(0, maxPromptMessageLength),
        '</message>',
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
 * without wrapping quotes, markdown, or a trailing period. Undefined when nothing is left.
 */
export function parseGeneratedTitle(reply: string) {
    const title = trimTrailingWrappers(
        createThreadTitle(reply)
            .replace(/^#+/, '')
            .trim()
            .replace(/^title:/i, '')
            .replace(/^["'`*_\s]+/, ''),
    ).trim();
    return title && title !== emptyTitle ? title : undefined;
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
    const slug = title
        .toLowerCase()
        .replaceAll(/[^a-z0-9]+/g, '-')
        .slice(0, 40)
        .replaceAll(/^-|-$/g, '');
    return `${slug || 'thread'}-${randomString(6).toLowerCase()}`;
}
