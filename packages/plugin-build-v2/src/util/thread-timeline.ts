import {removeDuplicates} from '@augment-vir/common';
import {ThreadItemKind, type Thread, type ThreadItem} from '../build-v2-api.js';

/** A checkout the sidebar lists threads under. */
export type ThreadRepo = Readonly<{
    path: string;
    name: string;
}>;

/** One repo's threads in the sidebar. */
export type ThreadRepoGroup = {
    repo: ThreadRepo;
    /** Latest activity first. */
    threads: Thread[];
};

/** The last segment of `path`, for a repo the app's folder list doesn't name. */
export function findPathName(path: string) {
    return path.split('/').findLast(Boolean) || path;
}

/**
 * Groups threads under the repos they belong to. A thread whose repo isn't in `repos` still gets a
 * group, named after its path. Repos with the latest thread activity go first; repos without
 * threads keep their order from `repos`, after them.
 */
export function groupThreadsByRepo({
    repos,
    threads,
}: Readonly<{
    repos: ReadonlyArray<ThreadRepo>;
    threads: ReadonlyArray<Readonly<Thread>>;
}>): ThreadRepoGroup[] {
    const unlistedRepos = removeDuplicates(threads.map((thread) => thread.repoPath))
        .filter((repoPath) => !repos.some((repo) => repo.path === repoPath))
        .toSorted()
        .map((repoPath) => {
            return {
                path: repoPath,
                name: findPathName(repoPath),
            };
        });

    return [
        ...repos,
        ...unlistedRepos,
    ]
        .map((repo) => {
            return {
                repo,
                threads: threads
                    .filter((thread) => thread.repoPath === repo.path)
                    .toSorted((first, second) => second.updatedAt - first.updatedAt),
            };
        })
        .toSorted((first, second) => {
            return (second.threads[0]?.updatedAt || 0) - (first.threads[0]?.updatedAt || 0);
        });
}

/** Replaces the thread with the same id, or adds it first. */
export function upsertThread(threads: ReadonlyArray<Readonly<Thread>>, thread: Readonly<Thread>) {
    return threads.some((existing) => existing.id === thread.id)
        ? threads.map((existing) => (existing.id === thread.id ? thread : existing))
        : [
              thread,
              ...threads,
          ];
}

/** Replaces items with the same id, adds the rest, and orders the result by timeline position. */
export function upsertItems({
    items,
    changedItems,
}: Readonly<{
    items: ReadonlyArray<Readonly<ThreadItem>>;
    changedItems: ReadonlyArray<Readonly<ThreadItem>>;
}>) {
    return [
        ...items.filter((item) => !changedItems.some((changed) => changed.id === item.id)),
        ...changedItems,
    ].toSorted((first, second) => first.order - second.order);
}

/** Appends a streamed `delta` to the matching item's text. An unknown item id changes nothing. */
export function applyItemDelta(
    items: ReadonlyArray<Readonly<ThreadItem>>,
    {
        itemId,
        delta,
    }: Readonly<{
        itemId: string;
        delta: string;
    }>,
) {
    return items.map((item) => {
        return item.id === itemId
            ? {
                  ...item,
                  text: item.text + delta,
              }
            : item;
    });
}

/** How the chat timeline shows a run of thread items. */
export enum TimelineEntryKind {
    UserMessage = 'userMessage',
    AssistantMessage = 'assistantMessage',
    /** Consecutive work items, folded into one collapsible work log. */
    Work = 'work',
    Notice = 'notice',
}

const timelineEntryKinds: Record<ThreadItemKind, TimelineEntryKind> = {
    [ThreadItemKind.UserMessage]: TimelineEntryKind.UserMessage,
    [ThreadItemKind.AssistantMessage]: TimelineEntryKind.AssistantMessage,
    [ThreadItemKind.Reasoning]: TimelineEntryKind.Work,
    [ThreadItemKind.Command]: TimelineEntryKind.Work,
    [ThreadItemKind.FileChange]: TimelineEntryKind.Work,
    [ThreadItemKind.ToolCall]: TimelineEntryKind.Work,
    [ThreadItemKind.Plan]: TimelineEntryKind.Work,
    [ThreadItemKind.Notice]: TimelineEntryKind.Notice,
};

/** One row of the chat timeline. Only a work entry holds more than one item. */
export type TimelineEntry = {
    kind: TimelineEntryKind;
    /** The first item's id, which stays the same as the entry grows. */
    key: string;
    items: ReadonlyArray<Readonly<ThreadItem>>;
};

/** Splits a thread's ordered items into timeline rows, folding each run of work items into one. */
export function buildTimeline(items: ReadonlyArray<Readonly<ThreadItem>>) {
    return items.reduce<TimelineEntry[]>((entries, item) => {
        const kind = timelineEntryKinds[item.kind];
        const last = entries.at(-1);
        if (kind === TimelineEntryKind.Work && last?.kind === TimelineEntryKind.Work) {
            return [
                ...entries.slice(0, -1),
                {
                    ...last,
                    items: [
                        ...last.items,
                        item,
                    ],
                },
            ];
        }
        return [
            ...entries,
            {
                kind,
                key: item.id,
                items: [
                    item,
                ],
            },
        ];
    }, []);
}

/** Counts a noun whose plural adds an "s". */
function pluralize(count: number, noun: string) {
    return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

const workSummaries: Record<ThreadItemKind, ((count: number) => string) | undefined> = {
    [ThreadItemKind.UserMessage]: undefined,
    [ThreadItemKind.AssistantMessage]: undefined,
    [ThreadItemKind.Notice]: undefined,
    [ThreadItemKind.Reasoning](count) {
        return count === 1 ? 'Thought' : `Thought ×${count}`;
    },
    [ThreadItemKind.Command](count) {
        return `Ran ${pluralize(count, 'command')}`;
    },
    [ThreadItemKind.FileChange](count) {
        return `Changed ${pluralize(count, 'file')}`;
    },
    [ThreadItemKind.ToolCall](count) {
        return `Used ${pluralize(count, 'tool')}`;
    },
    [ThreadItemKind.Plan]() {
        return 'Updated the plan';
    },
};

/**
 * One line naming what a work log did, in the order each kind of work first happened: at most two
 * kinds, then how many more kinds there were.
 *
 * @example
 *
 * ```ts
 * summarizeWork(items); // 'Ran 3 commands, Changed 1 file +1 more'
 * ```
 */
export function summarizeWork(items: ReadonlyArray<Readonly<ThreadItem>>) {
    const kinds = removeDuplicates(items.map((item) => item.kind));
    const summaries = kinds.flatMap((kind) => {
        const summarize = workSummaries[kind];
        return summarize
            ? [
                  summarize(items.filter((item) => item.kind === kind).length),
              ]
            : [];
    });
    const shown = summaries.slice(0, 2).join(', ');
    return summaries.length > 2 ? `${shown} +${summaries.length - 2} more` : shown;
}
