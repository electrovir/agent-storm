import {type PluginServerContext} from '@agent-storm/core/server';
import {assertWrap} from '@augment-vir/assert';
import {awaitedBlockingMap, type PartialWithUndefined} from '@augment-vir/common';
import {getNowInIsoString} from 'date-vir';
import {assertValidShape, defineShape} from 'object-shape-tester';
import {
    AiProvider,
    ApprovalDecision,
    ApprovalKind,
    ReasoningEffort,
    RuntimeMode,
    ThreadItemKind,
    ThreadItemStatus,
    ThreadStatus,
    userQuestionShape,
    type ApprovalRequest,
    type buildV2Api,
    type Thread,
    type ThreadItem,
} from '../build-v2-api.js';
import {type Prisma, type PrismaClient} from './generated/client.js';

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
} satisfies Prisma.ThreadSelect;

const itemSelect = {
    id: true,
    createdAt: true,
    threadId: true,
    turnId: true,
    kind: true,
    status: true,
    title: true,
    text: true,
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
        createdAt: createdAt.getTime(),
        updatedAt: updatedAt.getTime(),
    };
}

export function toThreadItem({
    createdAt,
    kind,
    status,
    ...row
}: Readonly<Prisma.ThreadItemGetPayload<{select: typeof itemSelect}>>): ThreadItem {
    return {
        ...row,
        kind: assertWrap.isEnumValue(kind, ThreadItemKind),
        status: assertWrap.isEnumValue(status, ThreadItemStatus),
        createdAt: createdAt.getTime(),
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
    Pick<ThreadItem, 'threadId' | 'turnId' | 'kind' | 'status' | 'title' | 'text'> & {
        /** The provider's own id for the item, which later updates to it reuse. */
        providerItemId?: string | undefined;
    }
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
    emit: PluginServerContext<typeof buildV2Api>['emit'];
}>) {
    /**
     * The text streamed so far into each in-progress item, by `threadId` and provider item id. The
     * database only gets an item's text once the provider sends the whole item.
     */
    const streamingItems = new Map<string, {itemId: string; threadId: string; text: string}>();

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

    async function updateThread(
        threadId: string,
        data: Readonly<
            Pick<
                Prisma.ThreadUpdateInput,
                | 'cwd'
                | 'worktreeBranch'
                | 'provider'
                | 'model'
                | 'speedTier'
                | 'effort'
                | 'runtimeMode'
                | 'title'
                | 'hasCustomTitle'
                | 'status'
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
        updateThread,
        async listThreads() {
            return (
                await prismaClient.thread.findMany({
                    where: {
                        deactivatedAt: null,
                    },
                    orderBy: {
                        updatedAt: 'desc',
                    },
                    select: threadSelect,
                })
            ).map(toThread);
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
                    PartialWithUndefined<Pick<Thread, 'cwd'>>
            >,
        ) {
            const thread = toThread(
                await prismaClient.thread.create({
                    data: {
                        ...data,
                        effort: data.effort ?? null,
                        speedTier: data.speedTier || null,
                        cwd: data.cwd || data.repoPath,
                        status: ThreadStatus.Idle,
                    },
                    select: threadSelect,
                }),
            );
            emit('threadChanged', thread);
            return thread;
        },
        /** Gives the thread a generated title, unless it was renamed by the user or an agent. */
        async setGeneratedTitle({threadId, title}: Readonly<{threadId: string; title: string}>) {
            const {count} = await prismaClient.thread.updateMany({
                where: {
                    id: threadId,
                    hasCustomTitle: false,
                    title: {
                        not: title,
                    },
                },
                data: {
                    title,
                },
            });
            if (count) {
                emit('threadChanged', await findThread(threadId));
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
            };
        },
        async listRepoActivity() {
            const rows = await prismaClient.thread.groupBy({
                by: [
                    'repoPath',
                ],
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
                findThread(threadId),
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
            const streamedTexts = new Map(
                [...streamingItems.values()].map((streaming) => {
                    return [
                        streaming.itemId,
                        streaming.text,
                    ];
                }),
            );
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
        async putItem({providerItemId, ...item}: ItemUpdate) {
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
                      },
                      select: itemSelect,
                  })
                : await prismaClient.threadItem.create({
                      data: {
                          ...item,
                          providerItemId: providerItemId ?? null,
                          order: await findNextOrder(item.threadId),
                      },
                      select: itemSelect,
                  });
            if (providerItemId) {
                const key = `${item.threadId}:${providerItemId}`;
                if (item.status === ThreadItemStatus.InProgress) {
                    streamingItems.set(key, {
                        itemId: row.id,
                        threadId: item.threadId,
                        text: row.text,
                    });
                } else {
                    streamingItems.delete(key);
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
        async markThreadRead(threadId: string) {
            const {updatedAt, hasUnreadReply} = await prismaClient.thread.findUniqueOrThrow({
                where: {
                    id: threadId,
                },
                select: {
                    updatedAt: true,
                    hasUnreadReply: true,
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
            emit('threadChanged', thread);
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
            const key = `${threadId}:${providerItemId}`;
            const streaming = streamingItems.get(key);
            if (!streaming || !delta) {
                return;
            }
            streamingItems.set(key, {
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
                >
            >,
        ) {
            const created = toApprovalRequest(
                await prismaClient.approvalRequest.create({
                    data: {
                        ...request,
                        questions: JSON.stringify(request.questions),
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
            return requests;
        },
        /**
         * Fails a thread's unfinished items, keeping the text they streamed, once its provider
         * stops.
         */
        async failUnfinishedItems(threadId: string) {
            const streamed = [...streamingItems.entries()].filter(
                ([
                    ,
                    streaming,
                ]) => {
                    return streaming.threadId === threadId;
                },
            );
            streamed.forEach(([key]) => {
                streamingItems.delete(key);
            });
            const streamedTexts = new Map(
                streamed.map(
                    ([
                        ,
                        streaming,
                    ]) => {
                        return [
                            streaming.itemId,
                            streaming.text,
                        ];
                    },
                ),
            );
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
         * Settles what a previous run left mid-flight, since no provider survives the server
         * stopping: pending requests are declined, unfinished items fail, and busy threads go idle,
         * each with a notice saying why its turn stopped. Resolves to those threads, each with the
         * messages the user sent after the one that started its turn.
         */
        async settleInterruptedWork() {
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
            await prismaClient.$transaction([
                prismaClient.approvalRequest.updateMany({
                    where: {
                        resolvedAt: null,
                    },
                    data: {
                        resolvedAt: getNowInIsoString(),
                        decision: ApprovalDecision.Decline,
                    },
                }),
                prismaClient.threadItem.updateMany({
                    where: {
                        status: ThreadItemStatus.InProgress,
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
                    },
                    data: {
                        status: ThreadStatus.Idle,
                    },
                }),
            ]);
            return await awaitedBlockingMap(busyThreads, async (thread) => {
                const turnId = thread.items[0]?.turnId || '';
                await this.putItem(
                    this.notice({
                        threadId: thread.id,
                        turnId,
                        text: 'Agent Storm restarted during this turn, so it is continuing the turn.',
                    }),
                );
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
