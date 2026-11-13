import {randomString} from '@augment-vir/common';

const maxTitleLength = 60;

/** A thread's title from its first message: the first non-empty line, shortened with `…`. */
export function createThreadTitle(text: string) {
    const firstLine =
        text
            .split('\n')
            .map((line) => line.trim())
            .find(Boolean) || 'New thread';
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
