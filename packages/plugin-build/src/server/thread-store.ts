// cspell:words unarchived unarchiving
import {
    sidebarThreadOrigins,
    type PluginThread,
    type PluginThreadsTarget,
} from '@agent-storm/common';
import {type PluginServerContext} from '@agent-storm/core/server';
import {assertWrap} from '@augment-vir/assert';
import {
    awaitedBlockingMap,
    getOrSetFromMap,
    groupArrayBy,
    type PartialWithUndefined,
} from '@augment-vir/common';
import {convertDuration, getNowInIsoString} from 'date-vir';
import {assertValidShape, defineShape} from 'object-shape-tester';
import {
    AiProvider,
    ApprovalDecision,
    ApprovalKind,
    ReasoningEffort,
    RuntimeMode,
    ThreadItemKind,
    ThreadItemStatus,
    ThreadOrigin,
    ThreadStatus,
    userQuestionShape,
    type ApprovalRequest,
    type buildApi,
    type Thread,
    type ThreadItem,
} from '../build-api.js';
import {type Prisma, type PrismaClient} from './generated/client.js';
import {parsePluginLaunch, serializePluginLaunch, type PluginLaunch} from './plugin-launch.js';
import {type ProviderRequestId} from './providers/provider-session.js';

const activeSidebarThreadFilter = {
    deactivatedAt: null,
    origin: {
        in: sidebarThreadOrigins,
    },
} satisfies Prisma.ThreadWhereInput;

const threadSelect = {
    id: true,
    createdAt: true,
    updatedAt: true,
    repoPath: true,
    cwd: true,
    worktreeBranch: true,
    provider: true,
    model: true,
    effort: true,
    speedTier: true,
    runtimeMode: true,
    title: true,
    status: true,
    hasUnreadReply: true,
    isPriority: true,
    backgroundTaskCount: true,
    origin: true,
    prUrl: true,
    parentThreadId: true,
    requests: {
        where: {
            resolvedAt: null,
        },
        select: {
            kind: true,
        },
    },
    items: {
        where: {
            kind: ThreadItemKind.UserMessage,
        },
        orderBy: {
            createdAt: 'desc',
        },
        take: 1,
        select: {
            createdAt: true,
        },
    },
    _count: {
        select: {
            items: {
                where: {
                    kind: ThreadItemKind.UserMessage,
                },
            },
        },
    },
} satisfies Prisma.ThreadSelect;

const itemSelect = {
    id: true,
    createdAt: true,
    updatedAt: true,
    threadId: true,
    turnId: true,
    kind: true,
    status: true,
    title: true,
    text: true,
    imagePaths: true,
    order: true,
} satisfies Prisma.ThreadItemSelect;

const requestSelect = {
    id: true,
    createdAt: true,
    threadId: true,
    kind: true,
    title: true,
    detail: true,
    reason: true,
    questions: true,
} satisfies Prisma.ApprovalRequestSelect;

const storedQuestionsShape = defineShape([
    userQuestionShape,
]);

const storedImagePathsShape = defineShape([
    '',
]);

/**
 * Prisma types each enum column as its own string union, which the API's enum with the same values
 * doesn't accept without a cast. The `satisfies` keeps the two value sets checked against each
 * other.
 */
export function toThread({
    createdAt,
    updatedAt,
    provider,
    status,
    effort,
    runtimeMode,
    origin,
    requests,
    items,
    _count,
    ...row
}: Readonly<Prisma.ThreadGetPayload<{select: typeof threadSelect}>>): Thread {
    return {
        ...row,
        ...(effort
            ? {
                  effort: assertWrap.isEnumValue(effort, ReasoningEffort),
              }
            : {}),
        provider: assertWrap.isEnumValue(provider, AiProvider),
        runtimeMode: assertWrap.isEnumValue(runtimeMode, RuntimeMode),
        status: assertWrap.isEnumValue(status, ThreadStatus),
        origin: assertWrap.isEnumValue(origin, ThreadOrigin),
        isAskingQuestion:
            !!requests.length &&
            requests.every(
                ({kind}) => assertWrap.isEnumValue(kind, ApprovalKind) === ApprovalKind.Question,
            ),
        userMessageCount: _count.items,
        lastUserMessageAt: (items[0]?.createdAt ?? createdAt).getTime(),
        createdAt: createdAt.getTime(),
        updatedAt: updatedAt.getTime(),
    };
}

export function toThreadItem({
    createdAt,
    updatedAt,
    kind,
    status,
    imagePaths,
    ...row
}: Readonly<Prisma.ThreadItemGetPayload<{select: typeof itemSelect}>>): ThreadItem {
    const parsedImagePaths: unknown = JSON.parse(imagePaths);
    assertValidShape(parsedImagePaths, storedImagePathsShape);
    return {
        ...row,
        imagePaths: parsedImagePaths,
        kind: assertWrap.isEnumValue(kind, ThreadItemKind),
        status: assertWrap.isEnumValue(status, ThreadItemStatus),
        createdAt: createdAt.getTime(),
        updatedAt: updatedAt.getTime(),
    };
}

export function toApprovalRequest({
    createdAt,
    kind,
    questions,
    ...row
}: Readonly<Prisma.ApprovalRequestGetPayload<{select: typeof requestSelect}>>): ApprovalRequest {
    const parsedQuestions: unknown = JSON.parse(questions);
    assertValidShape(parsedQuestions, storedQuestionsShape);
    return {
        ...row,
        kind: assertWrap.isEnumValue(kind, ApprovalKind),
        questions: parsedQuestions,
        createdAt: createdAt.getTime(),
    };
}

/** An item to create, or to replace when one with the same `providerItemId` exists. */
export type ItemUpdate = Readonly<
    Pick<ThreadItem, 'threadId' | 'turnId' | 'kind' | 'status' | 'title' | 'text'> &
        PartialWithUndefined<{
            /** The provider's own id for the item, which later updates to it reuse. */
            providerItemId: string;
            /** Replaces the item's images. None when unset. */
            imagePaths: ReadonlyArray<string>;
        }>
>;

/**
 * Reads and writes threads, their items, and their requests, and tells every open window about each
 * change.
 */
export function createThreadStore({
    prismaClient,
    emit,
}: Readonly<{
    prismaClient: PrismaClient;
    emit: PluginServerContext<typeof buildApi>['emit'];
}>) {
    /**
     * The text streamed so far into each in-progress item, by `threadId` and provider item id. The
     * database only gets an item's text once the provider sends the whole item.
     */
    const streamingItems = new Map<string, Map<string, {itemId: string; text: string}>>();

    function readStreamedTexts(threadId: string) {
        return new Map<string, string>(
            Array.from(streamingItems.get(threadId)?.values() || [], ({itemId, text}) => {
                return [
                    itemId,
                    text,
                ];
            }),
        );
    }

    async function findThread(threadId: string) {
        return toThread(
            await prismaClient.thread.findUniqueOrThrow({
                where: {
                    id: threadId,
                    deactivatedAt: null,
                },
                select: threadSelect,
            }),
        );
    }

    /**
     * Whether the thread exists and isn't archived. A one-column query, unlike `findThread`, for
     * checks that run on every request.
     */
    async function isThreadActive(threadId: string) {
        return !!(await prismaClient.thread.findFirst({
            where: {
                id: threadId,
                deactivatedAt: null,
            },
            select: {
                id: true,
            },
        }));
    }

    async function updateThread(
        threadId: string,
        data: Readonly<
            Pick<
                Prisma.ThreadUpdateInput,
                | 'repoPath'
                | 'cwd'
                | 'worktreeBranch'
                | 'provider'
                | 'model'
                | 'speedTier'
                | 'effort'
                | 'runtimeMode'
                | 'title'
                | 'hasCustomTitle'
                | 'isPriority'
                | 'hasUnreadReply'
                | 'status'
                | 'backgroundTaskCount'
                | 'providerSessionId'
                | 'updatedAt'
            >
        >,
    ) {
        const thread = toThread(
            await prismaClient.thread.update({
                where: {
                    id: threadId,
                },
                data,
                select: threadSelect,
            }),
        );
        emit('threadChanged', thread);
        return thread;
    }

    async function listPendingRequests(threadId: string) {
        return (
            await prismaClient.approvalRequest.findMany({
                where: {
                    threadId,
                    resolvedAt: null,
                },
                orderBy: {
                    createdAt: 'asc',
                },
                select: requestSelect,
            })
        ).map(toApprovalRequest);
    }

    async function findNextOrder(threadId: string) {
        const {_max} = await prismaClient.threadItem.aggregate({
            where: {
                threadId,
            },
            _max: {
                order: true,
            },
        });
        return (_max.order ?? -1) + 1;
    }

    return {
        findThread,
        isThreadActive,
        updateThread,
        /** The newest thread of `origin` in each of `folders` that isn't archived, in their order. */
        async findNewestThreads({folders, origin}: PluginThreadsTarget) {
            const rows = await prismaClient.thread.findMany({
                where: {
                    deactivatedAt: null,
                    cwd: {
                        in: [...folders],
                    },
                    origin,
                },
                orderBy: {
                    createdAt: 'desc',
                },
                select: {
                    id: true,
                    cwd: true,
                    status: true,
                    origin: true,
                },
            });
            const newestByFolder = new Map<string, (typeof rows)[number]>();
            rows.forEach((row) => {
                if (!newestByFolder.has(row.cwd)) {
                    newestByFolder.set(row.cwd, row);
                }
            });
            return folders.map((cwd): PluginThread | undefined => {
                const row = newestByFolder.get(cwd);
                return (
                    row && {
                        id: row.id,
                        status: assertWrap.isEnumValue(row.status, ThreadStatus),
                        origin: assertWrap.isEnumValue(row.origin, ThreadOrigin),
                    }
                );
            });
        },
        /** The sidebar's threads, leaving out the ones other plugins started. */
        async listThreads() {
            return (
                await prismaClient.thread.findMany({
                    where: activeSidebarThreadFilter,
                    orderBy: {
                        updatedAt: 'desc',
                    },
                    select: threadSelect,
                })
            ).map(toThread);
        },
        async hasSidebarThreadInFolder(cwd: string) {
            return !!(await prismaClient.thread.findFirst({
                where: {
                    ...activeSidebarThreadFilter,
                    cwd,
                },
                select: {
                    id: true,
                },
            }));
        },
        async listActiveThreadGroups() {
            const rows = await prismaClient.thread.findMany({
                where: {
                    deactivatedAt: null,
                },
                orderBy: {
                    updatedAt: 'desc',
                },
                select: threadSelect,
            });
            const groups = groupArrayBy(rows.map(toThread), ({origin}) => {
                return sidebarThreadOrigins.includes(origin)
                    ? 'threads'
                    : origin === ThreadOrigin.SideChat
                      ? 'sideChats'
                      : 'paneThreads';
            });
            return {
                threads: groups.threads || [],
                sideChats: groups.sideChats || [],
                paneThreads: groups.paneThreads || [],
            };
        },
        async createThread(
            data: Readonly<
                Pick<
                    Thread,
                    | 'id'
                    | 'repoPath'
                    | 'provider'
                    | 'model'
                    | 'effort'
                    | 'speedTier'
                    | 'runtimeMode'
                    | 'title'
                > &
                    PartialWithUndefined<
                        Pick<
                            Thread,
                            'cwd' | 'origin' | 'prUrl' | 'parentThreadId' | 'isPriority'
                        > & {
                            hasCustomTitle: boolean;
                            pluginLaunch: PluginLaunch;
                        }
                    >
            >,
        ) {
            const thread = toThread(
                await prismaClient.thread.create({
                    data: {
                        ...data,
                        effort: data.effort ?? null,
                        speedTier: data.speedTier || null,
                        cwd: data.cwd || data.repoPath,
                        origin: data.origin || ThreadOrigin.User,
                        prUrl: data.prUrl || null,
                        parentThreadId: data.parentThreadId || null,
                        pluginLaunch: data.pluginLaunch
                            ? serializePluginLaunch(data.pluginLaunch)
                            : null,
                        hasCustomTitle: !!data.hasCustomTitle,
                        isPriority: !!data.isPriority,
                        status: ThreadStatus.Idle,
                    },
                    select: threadSelect,
                }),
            );
            emit('threadChanged', thread);
            return thread;
        },
        /**
         * Gives the thread a generated title, unless it was renamed by the user or an agent. With
         * `isFinal`, later generated titles don't replace it either.
         */
        async setGeneratedTitle({
            threadId,
            title,
            isFinal,
        }: Readonly<{threadId: string; title: string; isFinal: boolean}>) {
            const {count} = await prismaClient.thread.updateMany({
                where: {
                    id: threadId,
                    hasCustomTitle: false,
                    ...(isFinal
                        ? {}
                        : {
                              title: {
                                  not: title,
                              },
                          }),
                },
                data: {
                    title,
                    hasCustomTitle: isFinal,
                },
            });
            if (count) {
                emit('threadChanged', await findThread(threadId));
            }
        },
        /** Whether a plugin started the thread to run with nobody there to answer its requests. */
        async isThreadUnattended(threadId: string) {
            const thread = await prismaClient.thread.findUnique({
                where: {
                    id: threadId,
                },
                select: {
                    pluginLaunch: true,
                },
            });
            return !!thread?.pluginLaunch && parsePluginLaunch(thread.pluginLaunch).isUnattended;
        },
        /** Does nothing for a thread no plugin started. */
        async setThreadUnattended({
            threadId,
            isUnattended,
        }: Readonly<{
            threadId: string;
            isUnattended: boolean;
        }>) {
            const {pluginLaunch} = await prismaClient.thread.findUniqueOrThrow({
                where: {
                    id: threadId,
                },
                select: {
                    pluginLaunch: true,
                },
            });
            if (pluginLaunch) {
                await prismaClient.thread.update({
                    where: {
                        id: threadId,
                    },
                    data: {
                        pluginLaunch: serializePluginLaunch({
                            ...parsePluginLaunch(pluginLaunch),
                            isUnattended,
                        }),
                    },
                    select: {
                        id: true,
                    },
                });
            }
        },
        /** What starting the thread's provider needs, and whether it has a custom title. */
        async findSessionDetails(threadId: string) {
            const {provider, ...details} = await prismaClient.thread.findUniqueOrThrow({
                where: {
                    id: threadId,
                    deactivatedAt: null,
                },
                select: {
                    provider: true,
                    cwd: true,
                    model: true,
                    effort: true,
                    speedTier: true,
                    runtimeMode: true,
                    providerSessionId: true,
                    hasCustomTitle: true,
                    pluginLaunch: true,
                },
            });
            return {
                ...details,
                effort: details.effort
                    ? assertWrap.isEnumValue(details.effort, ReasoningEffort)
                    : undefined,
                speedTier: details.speedTier || undefined,
                runtimeMode: assertWrap.isEnumValue(details.runtimeMode, RuntimeMode),
                provider: assertWrap.isEnumValue(provider, AiProvider),
                pluginLaunch: details.pluginLaunch
                    ? parsePluginLaunch(details.pluginLaunch)
                    : undefined,
            };
        },
        async listRepoActivity() {
            const rows = await prismaClient.thread.groupBy({
                by: [
                    'repoPath',
                ],
                where: {
                    origin: {
                        in: sidebarThreadOrigins,
                    },
                },
                _max: {
                    updatedAt: true,
                },
            });
            return rows.map(({repoPath, _max}) => {
                return {
                    repoPath,
                    updatedAt: _max.updatedAt?.getTime() || 0,
                };
            });
        },
        async listArchivedThreads() {
            return (
                await prismaClient.thread.findMany({
                    where: {
                        deactivatedAt: {
                            not: null,
                        },
                    },
                    orderBy: {
                        updatedAt: 'desc',
                    },
                    select: threadSelect,
                })
            ).map(toThread);
        },
        async findArchivedThread(threadId: string) {
            return toThread(
                await prismaClient.thread.findUniqueOrThrow({
                    where: {
                        id: threadId,
                        deactivatedAt: {
                            not: null,
                        },
                    },
                    select: threadSelect,
                }),
            );
        },
        async unarchiveThread({
            threadId,
            cwd,
        }: Readonly<{
            threadId: string;
            cwd: string | undefined;
        }>) {
            const thread = toThread(
                await prismaClient.thread.update({
                    where: {
                        id: threadId,
                    },
                    data: {
                        deactivatedAt: null,
                        ...(cwd
                            ? {
                                  cwd,
                              }
                            : {}),
                    },
                    select: threadSelect,
                }),
            );
            emit('threadChanged', thread);
            return thread;
        },
        async archiveThread(threadId: string) {
            const {updatedAt} = await prismaClient.thread.findUniqueOrThrow({
                where: {
                    id: threadId,
                },
                select: {
                    updatedAt: true,
                },
            });
            await prismaClient.thread.update({
                where: {
                    id: threadId,
                },
                /**
                 * Archiving isn't activity: passing `updatedAt` keeps Prisma's `@updatedAt` from
                 * bumping it, which would move the repo in the sidebar's activity sort.
                 */
                data: {
                    deactivatedAt: getNowInIsoString(),
                    updatedAt,
                },
                select: {
                    id: true,
                },
            });
            emit('threadArchived', {
                threadId,
            });
        },
        async readThread(threadId: string) {
            const [
                thread,
                itemRows,
                requests,
            ] = await Promise.all([
                /** Archived threads included, since the user can open one without unarchiving it. */
                prismaClient.thread
                    .findUniqueOrThrow({
                        where: {
                            id: threadId,
                        },
                        select: threadSelect,
                    })
                    .then(toThread),
                prismaClient.threadItem.findMany({
                    where: {
                        threadId,
                    },
                    orderBy: {
                        order: 'asc',
                    },
                    select: itemSelect,
                }),
                listPendingRequests(threadId),
            ]);
            const streamedTexts = readStreamedTexts(threadId);
            return {
                thread,
                items: itemRows.map((row) => {
                    return {
                        ...toThreadItem(row),
                        text: streamedTexts.get(row.id) ?? row.text,
                    };
                }),
                requests,
            };
        },
        async putItem({providerItemId, imagePaths, ...item}: ItemUpdate) {
            const existing = providerItemId
                ? await prismaClient.threadItem.findUnique({
                      where: {
                          threadId_providerItemId: {
                              threadId: item.threadId,
                              providerItemId,
                          },
                      },
                      select: {
                          id: true,
                      },
                  })
                : undefined;
            const row = existing
                ? await prismaClient.threadItem.update({
                      where: {
                          id: existing.id,
                      },
                      data: {
                          kind: item.kind,
                          status: item.status,
                          title: item.title,
                          text: item.text,
                          imagePaths: JSON.stringify(imagePaths ?? []),
                      },
                      select: itemSelect,
                  })
                : await prismaClient.threadItem.create({
                      data: {
                          ...item,
                          imagePaths: JSON.stringify(imagePaths ?? []),
                          providerItemId: providerItemId ?? null,
                          order: await findNextOrder(item.threadId),
                      },
                      select: itemSelect,
                  });
            if (providerItemId) {
                if (item.status === ThreadItemStatus.InProgress) {
                    getOrSetFromMap(streamingItems, item.threadId, () => new Map()).set(
                        providerItemId,
                        {
                            itemId: row.id,
                            text: row.text,
                        },
                    );
                } else {
                    const threadItems = streamingItems.get(item.threadId);
                    if (threadItems?.delete(providerItemId) && !threadItems.size) {
                        streamingItems.delete(item.threadId);
                    }
                }
            }
            const threadItem = toThreadItem(row);
            emit('itemsChanged', {
                threadId: item.threadId,
                items: [
                    threadItem,
                ],
            });
            if (
                item.kind === ThreadItemKind.AssistantMessage &&
                item.status === ThreadItemStatus.Completed
            ) {
                const {count} = await prismaClient.thread.updateMany({
                    where: {
                        id: item.threadId,
                        hasUnreadReply: false,
                    },
                    data: {
                        hasUnreadReply: true,
                    },
                });
                if (count) {
                    emit('threadChanged', await findThread(item.threadId));
                }
            }
            return threadItem;
        },
        async setThreadPriority(threadId: string, isPriority: boolean) {
            const {updatedAt} = await prismaClient.thread.findUniqueOrThrow({
                where: {
                    id: threadId,
                },
                select: {
                    updatedAt: true,
                },
            });
            return await updateThread(threadId, {
                isPriority,
                /** Passing `updatedAt` keeps Prisma's `@updatedAt` from bumping it. */
                updatedAt,
            });
        },
        async markThreadRead(threadId: string) {
            const {updatedAt, hasUnreadReply, deactivatedAt} =
                await prismaClient.thread.findUniqueOrThrow({
                    where: {
                        id: threadId,
                    },
                    select: {
                        updatedAt: true,
                        hasUnreadReply: true,
                        deactivatedAt: true,
                    },
                });
            if (!hasUnreadReply) {
                return;
            }
            const thread = toThread(
                await prismaClient.thread.update({
                    where: {
                        id: threadId,
                    },
                    /** Passing `updatedAt` keeps Prisma's `@updatedAt` from bumping it. */
                    data: {
                        hasUnreadReply: false,
                        updatedAt,
                    },
                    select: threadSelect,
                }),
            );
            /** The client takes a changed thread as unarchived, which an opened archived one isn't. */
            if (!deactivatedAt) {
                emit('threadChanged', thread);
            }
        },
        async markThreadUnread(threadId: string) {
            const {updatedAt} = await prismaClient.thread.findUniqueOrThrow({
                where: {
                    id: threadId,
                },
                select: {
                    updatedAt: true,
                },
            });
            return await updateThread(threadId, {
                hasUnreadReply: true,
                /** Passing `updatedAt` keeps Prisma's `@updatedAt` from bumping it. */
                updatedAt,
            });
        },
        /** Ignores a delta for an item that isn't in progress. */
        appendDelta({
            threadId,
            providerItemId,
            delta,
        }: Readonly<{
            threadId: string;
            providerItemId: string;
            delta: string;
        }>) {
            const threadItems = streamingItems.get(threadId);
            const streaming = threadItems?.get(providerItemId);
            if (!threadItems || !streaming || !delta) {
                return;
            }
            threadItems.set(providerItemId, {
                ...streaming,
                text: streaming.text + delta,
            });
            emit('itemDelta', {
                threadId,
                itemId: streaming.itemId,
                delta,
            });
        },
        async addRequest(
            request: Readonly<
                Pick<
                    ApprovalRequest,
                    'threadId' | 'kind' | 'title' | 'detail' | 'reason' | 'questions'
                > &
                    ProviderRequestId
            >,
        ) {
            const created = toApprovalRequest(
                await prismaClient.approvalRequest.create({
                    data: {
                        ...request,
                        questions: JSON.stringify(request.questions),
                        providerRequestId: request.providerRequestId || '',
                    },
                    select: requestSelect,
                }),
            );
            emit('requestsChanged', {
                threadId: request.threadId,
                requests: await listPendingRequests(request.threadId),
            });
            return created;
        },
        /** Pending requests that a provider repeats once it reconnects. */
        async listProviderRequests() {
            return (
                await prismaClient.approvalRequest.findMany({
                    where: {
                        resolvedAt: null,
                        providerRequestId: {
                            not: '',
                        },
                    },
                    select: {
                        ...requestSelect,
                        providerRequestId: true,
                    },
                })
            ).map(({providerRequestId, ...row}) => {
                return {
                    ...toApprovalRequest(row),
                    providerRequestId,
                };
            });
        },
        /** Resolves to the thread's requests that are still pending. */
        async resolveRequest({
            requestId,
            decision,
        }: Readonly<{
            requestId: string;
            decision: ApprovalDecision;
        }>) {
            const {threadId} = await prismaClient.approvalRequest.update({
                where: {
                    id: requestId,
                },
                data: {
                    resolvedAt: getNowInIsoString(),
                    decision,
                },
                select: {
                    threadId: true,
                },
            });
            const requests = await listPendingRequests(threadId);
            emit('requestsChanged', {
                threadId,
                requests,
            });
            /** The thread keeps its status while requests remain, so nothing else re-sends it. */
            if (requests.length) {
                emit('threadChanged', await findThread(threadId));
            }
            return requests;
        },
        /**
         * Fails a thread's unfinished items, keeping the text they streamed, once its provider
         * stops.
         */
        async failUnfinishedItems(threadId: string) {
            const streamedTexts = readStreamedTexts(threadId);
            streamingItems.delete(threadId);
            const unfinished = await prismaClient.threadItem.findMany({
                where: {
                    threadId,
                    status: ThreadItemStatus.InProgress,
                },
                select: {
                    id: true,
                },
            });
            if (!unfinished.length) {
                return;
            }
            const rows = await prismaClient.$transaction(
                unfinished.map(({id}) => {
                    const text = streamedTexts.get(id);
                    return prismaClient.threadItem.update({
                        where: {
                            id,
                        },
                        data: {
                            status: ThreadItemStatus.Failed,
                            ...(text == undefined
                                ? {}
                                : {
                                      text,
                                  }),
                        },
                        select: itemSelect,
                    });
                }),
            );
            emit('itemsChanged', {
                threadId,
                items: rows.map(toThreadItem),
            });
        },
        /**
         * Settles what a previous run left mid-flight. Pending requests are declined unless their
         * provider is still running and repeats them by id once a session takes it over: those stay
         * pending, for the new session to pick up. The busy threads whose provider stopped with the
         * server go idle with their unfinished items failed and a notice saying why. Resolves to
         * every busy thread, each with the messages the user sent after the one that started its
         * turn.
         */
        async settleInterruptedWork({
            liveThreadIds,
        }: Readonly<{
            /** Threads whose provider process outlived the previous run. */
            liveThreadIds: ReadonlyArray<string>;
        }>) {
            const busyThreads = await prismaClient.thread.findMany({
                where: {
                    status: {
                        in: [
                            ThreadStatus.Running,
                            ThreadStatus.NeedsApproval,
                        ],
                    },
                },
                select: {
                    id: true,
                    items: {
                        select: {
                            turnId: true,
                        },
                        orderBy: {
                            order: 'desc',
                        },
                        take: 1,
                    },
                },
            });
            await prismaClient.$transaction(
                [
                    prismaClient.approvalRequest.updateMany({
                        where: {
                            resolvedAt: null,
                            OR: [
                                {
                                    providerRequestId: '',
                                },
                                {
                                    threadId: {
                                        notIn: [...liveThreadIds],
                                    },
                                },
                            ],
                        },
                        data: {
                            resolvedAt: getNowInIsoString(),
                            decision: ApprovalDecision.Decline,
                        },
                    }),
                    prismaClient.threadItem.updateMany({
                        where: {
                            status: ThreadItemStatus.InProgress,
                            threadId: {
                                notIn: [...liveThreadIds],
                            },
                        },
                        data: {
                            status: ThreadItemStatus.Failed,
                        },
                    }),
                    prismaClient.thread.updateMany({
                        where: {
                            status: {
                                in: [
                                    ThreadStatus.Running,
                                    ThreadStatus.NeedsApproval,
                                ],
                            },
                            id: {
                                notIn: [...liveThreadIds],
                            },
                        },
                        data: {
                            status: ThreadStatus.Idle,
                        },
                    }),
                    prismaClient.thread.updateMany({
                        where: {
                            status: ThreadStatus.NeedsApproval,
                            id: {
                                in: [...liveThreadIds],
                            },
                            requests: {
                                none: {
                                    resolvedAt: null,
                                },
                            },
                        },
                        data: {
                            status: ThreadStatus.Running,
                        },
                    }),
                ],
                {
                    /**
                     * Prisma rolls a transaction back after 5 seconds by default, and this runs at
                     * startup, when the database can be busy for longer than that (a write lock
                     * held by the previous server, a scan of the whole item table). Failing here
                     * leaves the plugin with no running server part.
                     */
                    timeout: convertDuration(
                        {
                            minutes: 1,
                        },
                        {
                            milliseconds: true,
                        },
                    ).milliseconds,
                },
            );
            return await awaitedBlockingMap(busyThreads, async (thread) => {
                const turnId = thread.items[0]?.turnId || '';
                const isLive = liveThreadIds.includes(thread.id);
                if (!isLive) {
                    await this.putItem(
                        this.notice({
                            threadId: thread.id,
                            turnId,
                            text: interruptedTurnNotice,
                        }),
                    );
                }
                const userMessages = await prismaClient.threadItem.findMany({
                    where: {
                        threadId: thread.id,
                        turnId,
                        kind: ThreadItemKind.UserMessage,
                    },
                    select: {
                        text: true,
                    },
                    orderBy: {
                        order: 'asc',
                    },
                });
                return {
                    threadId: thread.id,
                    turnId,
                    isLive,
                    /**
                     * The provider may not have saved any of these before the restart: messages
                     * sent while the turn ran wait in its in-memory queue, and Claude saves its
                     * transcript in the background, so even the message that started the turn can
                     * be lost.
                     */
                    turnMessages: userMessages.map((item) => item.text),
                };
            });
        },
        /** The item's kind, title, and text as last saved, by the provider's id for it. */
        async findProviderItem({
            threadId,
            providerItemId,
        }: Readonly<{
            threadId: string;
            providerItemId: string;
        }>) {
            const row = await prismaClient.threadItem.findUnique({
                where: {
                    threadId_providerItemId: {
                        threadId,
                        providerItemId,
                    },
                },
                select: {
                    kind: true,
                    title: true,
                    text: true,
                },
            });
            return row
                ? {
                      ...row,
                      kind: assertWrap.isEnumValue(row.kind, ThreadItemKind),
                  }
                : undefined;
        },
        notice({
            threadId,
            turnId,
            text,
        }: Readonly<{
            threadId: string;
            turnId: string;
            text: string;
        }>) {
            return {
                threadId,
                turnId,
                kind: ThreadItemKind.Notice,
                status: ThreadItemStatus.Completed,
                title: '',
                text,
            } satisfies ItemUpdate;
        },
    };
}

export type ThreadStore = ReturnType<typeof createThreadStore>;

/** Shown in a thread whose turn a restart stopped, before it is told to continue. */
export const interruptedTurnNotice =
    'Agent Storm restarted during this turn, so it is continuing the turn.';
