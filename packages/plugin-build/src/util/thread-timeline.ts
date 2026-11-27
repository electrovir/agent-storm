import {assertWrap, check} from '@augment-vir/assert';
import {
    arrayToObject,
    filterMap,
    getObjectTypedValues,
    groupArrayBy,
    removeDuplicates,
} from '@augment-vir/common';
import {ThreadItemKind, type Thread, type ThreadItem} from '../build-api.js';

/** A checkout the sidebar lists threads under. */
export type ThreadRepo = Readonly<{
    path: string;
    name: string;
}>;

/** One repo's threads in the sidebar. */
export type ThreadRepoGroup = {
    repo: ThreadRepo;
    /** Latest user message first. */
    threads: Thread[];
};

/** Epoch milliseconds of the latest activity among `threads`, or 0 when there are none. */
export function findLatestUpdate(threads: ReadonlyArray<Readonly<Thread>>) {
    return threads.reduce((latest, thread) => Math.max(latest, thread.updatedAt), 0);
}

/** The last segment of `path`, for a repo the app's folder list doesn't name. */
export function findPathName(path: string) {
    return path.split('/').findLast(Boolean) || path;
}

export function createThreadLookup(
    threads: ReadonlyArray<Readonly<Thread>>,
    getKey: (thread: Readonly<Thread>) => string | null | undefined,
) {
    const threadsByKey = groupArrayBy(threads, (thread) => JSON.stringify(getKey(thread) ?? null));
    return (key: string) => threadsByKey[JSON.stringify(key)] || [];
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
    const listedPaths = new Set(repos.map((repo) => repo.path));
    const findThreadsByRepo = createThreadLookup(threads, (thread) => thread.repoPath);
    const unlistedRepos = removeDuplicates(threads.map((thread) => thread.repoPath))
        .filter((repoPath) => !listedPaths.has(repoPath))
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
            const repoThreads = findThreadsByRepo(repo.path).toSorted(
                (first, second) => second.lastUserMessageAt - first.lastUserMessageAt,
            );
            return {
                group: {
                    repo,
                    threads: repoThreads,
                },
                latestUpdate: findLatestUpdate(repoThreads),
            };
        })
        .toSorted((first, second) => second.latestUpdate - first.latestUpdate)
        .map(({group}) => group);
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
    const changedItemIds = new Set(changedItems.map((item) => item.id));
    return [
        ...items.filter((item) => !changedItemIds.has(item.id)),
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
    const itemIndex = items.findLastIndex((item) => item.id === itemId);
    if (itemIndex < 0) {
        return items;
    }
    const item = assertWrap.isDefined(items[itemIndex]);
    return items.with(itemIndex, {
        ...item,
        text: item.text + delta,
    });
}

/** How the chat timeline shows a run of thread items. */
export enum TimelineEntryKind {
    UserMessage = 'userMessage',
    AssistantMessage = 'assistantMessage',
    /** Consecutive work items, folded into one collapsible work log. */
    Work = 'work',
    Notice = 'notice',
    QuestionAnswer = 'questionAnswer',
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
    [ThreadItemKind.QuestionAnswer]: TimelineEntryKind.QuestionAnswer,
};

/** One row of the chat timeline. Only a work entry holds more than one item. */
export type TimelineEntry = {
    kind: TimelineEntryKind;
    /** The first item's id, which stays the same as the entry grows. */
    key: string;
    items: ReadonlyArray<Readonly<ThreadItem>>;
};

/** Splits a thread's ordered items into timeline rows, folding each run of work items into one. */
export function buildTimeline(items: ReadonlyArray<Readonly<ThreadItem>>): TimelineEntry[] {
    const entryStarts = filterMap(
        items,
        (item, itemIndex) => {
            const kind = timelineEntryKinds[item.kind];
            const previousItem = items[itemIndex - 1];
            if (
                kind === TimelineEntryKind.Work &&
                previousItem &&
                timelineEntryKinds[previousItem.kind] === TimelineEntryKind.Work
            ) {
                return undefined;
            }
            return {
                itemIndex,
                kind,
                key: item.id,
            };
        },
        check.isDefined,
    );
    return entryStarts.map(({itemIndex, ...entry}, entryIndex) => {
        return {
            ...entry,
            items: items.slice(itemIndex, entryStarts[entryIndex + 1]?.itemIndex),
        };
    });
}

/** When a finished turn started and ended, in epoch milliseconds. */
export type TurnTiming = {
    startedAt: number;
    endedAt: number;
};

/**
 * Times each finished turn from its items, keyed by the id of the turn's last item, which the
 * timing shows under. Leaves out the latest turn while `isLatestTurnOpen`. A turn ends at its
 * latest item change, so a note the app adds after the turn, such as a move to a worktree, extends
 * it.
 */
export function findTurnTimings({
    items,
    isLatestTurnOpen,
}: Readonly<{
    items: ReadonlyArray<Readonly<ThreadItem>>;
    isLatestTurnOpen: boolean;
}>) {
    const openTurnId = isLatestTurnOpen ? items.findLast((item) => item.turnId)?.turnId : undefined;
    const turns = getObjectTypedValues(
        groupArrayBy(
            items.filter((item) => item.turnId && item.turnId !== openTurnId),
            (item) => item.turnId,
            {
                useRequired: true,
            },
        ),
    );
    return arrayToObject(turns, (turnItems) => {
        const startedAt = Math.min(...turnItems.map((item) => item.createdAt));
        return {
            key: assertWrap.isDefined(turnItems.at(-1)).id,
            value: {
                startedAt,
                endedAt: Math.max(startedAt, ...turnItems.map((item) => item.updatedAt)),
            } satisfies TurnTiming,
        };
    });
}

/** Counts a noun whose plural adds an "s". */
function pluralize(count: number, noun: string) {
    return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

const workSummaries: Record<ThreadItemKind, ((count: number) => string) | undefined> = {
    [ThreadItemKind.UserMessage]: undefined,
    [ThreadItemKind.AssistantMessage]: undefined,
    [ThreadItemKind.Notice]: undefined,
    [ThreadItemKind.QuestionAnswer]: undefined,
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
