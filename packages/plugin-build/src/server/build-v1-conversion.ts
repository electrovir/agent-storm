// cspell:words sidechain unarchived
import {type PaneGroupState, type PluginServerHost} from '@agent-storm/core/server';
import {type SessionStoreEntry} from '@anthropic-ai/claude-agent-sdk';
import {assertWrap, check} from '@augment-vir/assert';
import {
    addPrefix,
    awaitedBlockingMap,
    awaitedForEach,
    chunkArray,
    createCuid2,
    extractErrorMessage,
    extractExtension,
    getObjectTypedEntries,
    getObjectTypedKeys,
    getObjectTypedValues,
    log,
    mapObjectValues,
    removeDuplicates,
    typedObjectFromEntries,
} from '@augment-vir/common';
import {readDirRecursive} from '@augment-vir/node';
import {normalizePath, userDataDir} from 'agent-storm-util';
import {createUtcFullDate, getNowInUtcTimezone, toJsDate, toUtcIsoString} from 'date-vir';
import {randomUUID} from 'node:crypto';
import {readdir, readFile, realpath, stat, writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {basename, join} from 'node:path';
import {assertValidShape, defineShape, nullableShape, unknownShape} from 'object-shape-tester';
import {
    aiChatPaneId,
    AiProvider,
    providerLabels,
    RuntimeMode,
    ThreadItemKind,
    ThreadItemStatus,
    ThreadOrigin,
    ThreadStatus,
    toThreadScope,
} from '../build-api.js';
import {readModelDefaults, resolveThreadModelDefault} from '../util/model-default-settings.js';
import {createClaudeSessionStore} from './claude-session-store.js';
import {type PrismaClient} from './generated/client.js';
import {findClaudeConfigDir} from './providers/claude-commands.js';
import {
    completeClaudeToolItem,
    describeClaudeToolUse,
    readClaudeToolResultText,
} from './providers/claude-items.js';
import {createClaudeProjectKey} from './providers/claude-transcript.js';
import {describeCodexItem} from './providers/codex-items.js';
import {initializeCodexRpc} from './providers/codex-provider.js';
import {startCodexRpc, type CodexRpc} from './providers/codex-rpc.js';
import {type ProviderItem} from './providers/provider-session.js';

/** Written once every worktree is converted, so a worktree made later never gets converted. */
const conversionMarkerFileName = 'build-v1-converted';

/** The pane kind of Build v1's AI tabs, each a Claude Code or Codex session in a terminal. */
const legacyAiPaneKind = 'ai';

type ConvertedItem = Omit<ProviderItem, 'providerItemId'> & {
    providerItemId: string | null;
    turnId: string;
    createdAt: Date;
};

/**
 * The originators Codex's terminal UI records on its sessions. Other apps' sessions, Build's own
 * included, record their own.
 */
const codexCliOriginators = [
    'codex-tui',
    'codex_cli_rs',
];

const codexThreadListShape = defineShape({
    data: [
        {
            id: '',
            cwd: '',
            name: nullableShape(''),
            originator: nullableShape(''),
            createdAt: 0,
            updatedAt: 0,
        },
    ],
    nextCursor: nullableShape(''),
});

const codexThreadReadShape = defineShape({
    thread: {
        turns: [
            {
                id: '',
                startedAt: nullableShape(0),
                items: [
                    unknownShape(),
                ],
            },
        ],
    },
});

type ContentBlock = Readonly<Record<PropertyKey, unknown>>;

function readMessage(entry: Readonly<SessionStoreEntry>) {
    return check.isObject(entry.message) ? entry.message : {};
}

function readBlocks(content: unknown): ContentBlock[] {
    return check.isArray(content) ? content.filter(check.isObject) : [];
}

/** Claude Code saves a slash command as tags around its name and arguments. */
function readSlashCommand(text: string) {
    const name = /<command-name>([^<]*)<\/command-name>/.exec(text)?.[1]?.trim();
    if (!name) {
        return undefined;
    }
    return [
        addPrefix({
            value: name,
            prefix: '/',
        }),
        /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim(),
    ]
        .filter(Boolean)
        .join(' ');
}

/**
 * Turns a Claude Code transcript into the items the Claude provider would have saved had the
 * session run in a thread.
 */
export function buildItems(entries: ReadonlyArray<Readonly<SessionStoreEntry>>) {
    const mainEntries = entries.filter((entry) => entry.isSidechain !== true);
    const toolResults = new Map(
        mainEntries
            .filter((entry) => entry.type === 'user')
            .flatMap((entry) => readBlocks(readMessage(entry).content))
            .filter((block) => block.type === 'tool_result' && check.isString(block.tool_use_id))
            .map((block) => {
                return [
                    block.tool_use_id,
                    block,
                ];
            }),
    );
    /** A response's blocks can arrive split over several entries that share its message id. */
    const blockCounts = new Map<string, number>();
    const turn = {
        id: randomUUID(),
    };
    const blockItemReaders: Partial<
        Record<
            string,
            (
                params: Readonly<{block: ContentBlock; providerItemId: string}>,
            ) => Omit<ConvertedItem, 'turnId' | 'createdAt'> | undefined
        >
    > = {
        text({block, providerItemId}) {
            return check.isString(block.text) && block.text.trim()
                ? {
                      kind: ThreadItemKind.AssistantMessage,
                      status: ThreadItemStatus.Completed,
                      title: '',
                      text: block.text,
                      providerItemId,
                  }
                : undefined;
        },
        thinking({block, providerItemId}) {
            return check.isString(block.thinking) && block.thinking.trim()
                ? {
                      kind: ThreadItemKind.Reasoning,
                      status: ThreadItemStatus.Completed,
                      title: '',
                      text: block.thinking,
                      providerItemId,
                  }
                : undefined;
        },
        tool_use({block}) {
            if (!check.isString(block.id) || !check.isString(block.name)) {
                return undefined;
            }
            const tool = describeClaudeToolUse({
                name: block.name,
                input: check.isObject(block.input) ? block.input : {},
            });
            const result = toolResults.get(block.id);
            return {
                ...(result
                    ? completeClaudeToolItem({
                          tool,
                          output: readClaudeToolResultText(result.content),
                          isError: result.is_error === true,
                          isDeclined: false,
                      })
                    : {
                          ...tool,
                          status: ThreadItemStatus.Completed,
                      }),
                providerItemId: block.id,
            };
        },
    };
    const entryItemReaders: Partial<
        Record<string, (entry: Readonly<SessionStoreEntry>) => ConvertedItem[]>
    > = {
        user(entry) {
            const content = readMessage(entry).content;
            if (
                entry.isMeta === true ||
                entry.isCompactSummary === true ||
                entry.isVisibleInTranscriptOnly === true ||
                readBlocks(content).some((block) => block.type === 'tool_result')
            ) {
                return [];
            }
            const rawText = check.isString(content)
                ? content
                : readBlocks(content)
                      .filter((block) => block.type === 'text')
                      .map((block) => block.text)
                      .filter(check.isString)
                      .join('\n');
            const text = rawText.trim().startsWith('<')
                ? readSlashCommand(rawText)
                : rawText.startsWith('[Request interrupted')
                  ? undefined
                  : rawText;
            if (!text?.trim()) {
                return [];
            }
            turn.id = randomUUID();
            return [
                {
                    kind: ThreadItemKind.UserMessage,
                    status: ThreadItemStatus.Completed,
                    title: '',
                    text,
                    providerItemId: null,
                    turnId: turn.id,
                    createdAt: toJsDate(createUtcFullDate(entry.timestamp || Date.now())),
                },
            ];
        },
        assistant(entry) {
            const message = readMessage(entry);
            const blocks = readBlocks(message.content);
            const messageId = message.id;
            if (!check.isString(messageId)) {
                return [];
            }
            const firstIndex = blockCounts.get(messageId) ?? 0;
            blockCounts.set(messageId, firstIndex + blocks.length);
            return blocks.flatMap((block, offset) => {
                const item = check.isString(block.type)
                    ? blockItemReaders[block.type]?.({
                          block,
                          providerItemId: `${messageId}:${firstIndex + offset}`,
                      })
                    : undefined;
                return item
                    ? [
                          {
                              ...item,
                              turnId: turn.id,
                              createdAt: toJsDate(createUtcFullDate(entry.timestamp || Date.now())),
                          },
                      ]
                    : [];
            });
        },
    };
    return mainEntries.flatMap((entry) => entryItemReaders[entry.type]?.(entry) ?? []);
}

/** The title Claude Code shows for the session, or `fallback` when it has none. */
function readTitle({
    entries,
    fallback,
}: Readonly<{entries: ReadonlyArray<Readonly<SessionStoreEntry>>; fallback: string}>) {
    const customTitle = entries
        .filter((entry) => entry.type === 'custom-title')
        .map((entry) => entry.customTitle)
        .findLast(check.isString);
    const aiTitle = entries
        .filter((entry) => entry.type === 'ai-title')
        .map((entry) => entry.aiTitle)
        .findLast(check.isString);
    return customTitle || aiTitle || fallback;
}

async function readTranscript(path: string) {
    return (await readFile(path, 'utf8')).split('\n').flatMap((line): SessionStoreEntry[] => {
        if (!line.trim()) {
            return [];
        }
        try {
            const parsed: unknown = JSON.parse(line);
            return check.isObject(parsed) && check.isString(parsed.type)
                ? [
                      {
                          ...parsed,
                          type: parsed.type,
                      },
                  ]
                : [];
        } catch {
            return [];
        }
    });
}

/** Ids of the Claude sessions Build v1's AI tabs ran, from the files that tie a tab to one. */
async function readClaimedSessionIds() {
    const claimsDir = join(userDataDir, 'conversations', 'claude');
    const fileNames = await readdir(claimsDir).catch((): string[] => []);
    return removeDuplicates(
        await Promise.all(
            fileNames
                /** A plain terminal tab's Claude session, which no AI tab showed. */
                .filter((fileName) => !fileName.startsWith('terminal-'))
                .map(async (fileName) => {
                    return (await readFile(join(claimsDir, fileName), 'utf8')).trim();
                }),
        ),
    ).filter(Boolean);
}

/** The text of a Codex user message item, or undefined for any other item. */
function readCodexUserText(item: unknown) {
    if (!check.isObject(item) || item.type !== 'userMessage' || !check.isArray(item.content)) {
        return undefined;
    }
    return item.content
        .filter(check.isObject)
        .filter((input) => input.type === 'text')
        .map((input) => input.text)
        .filter(check.isString)
        .join('\n');
}

/** Recursive, so its return type can't be inferred. */
async function listCodexThreads({
    rpc,
    cwd,
    cursor,
}: Readonly<{
    rpc: CodexRpc;
    cwd: string;
    cursor: string | null;
}>): Promise<(typeof codexThreadListShape.runtimeType)['data']> {
    const response = await rpc.request('thread/list', {
        cwd,
        cursor,
    });
    assertValidShape(response, codexThreadListShape, {
        allowExtraKeys: true,
    });
    return [
        ...response.data,
        ...(response.nextCursor
            ? await listCodexThreads({
                  rpc,
                  cwd,
                  cursor: response.nextCursor,
              })
            : []),
    ];
}

/**
 * The sessions Codex's terminal UI ran in `folder`, as Build v1's AI tabs did, with the items the
 * Codex provider would have saved had each run in a thread.
 */
async function readCodexSessions({
    rpc,
    folder,
    fallbackTitle,
}: Readonly<{
    rpc: CodexRpc;
    folder: string;
    fallbackTitle: string;
}>) {
    const threads = (
        await listCodexThreads({
            rpc,
            cwd: folder,
            cursor: null,
        })
    ).filter((thread) => {
        /** The folder is checked here too in case the installed Codex predates the `cwd` filter. */
        return (
            normalizePath(thread.cwd) === normalizePath(folder) &&
            codexCliOriginators.includes(thread.originator || '')
        );
    });
    return await awaitedBlockingMap(threads, async (thread) => {
        const response = await rpc.request('thread/read', {
            threadId: thread.id,
            includeTurns: true,
        });
        assertValidShape(response, codexThreadReadShape, {
            allowExtraKeys: true,
        });
        return {
            provider: AiProvider.Codex,
            sessionId: thread.id,
            items: response.thread.turns.flatMap((turn) => {
                return turn.items.flatMap((item): ConvertedItem[] => {
                    const userText = readCodexUserText(item);
                    const converted =
                        userText == undefined
                            ? describeCodexItem({
                                  item,
                                  isCompleted: true,
                              })
                            : userText.trim()
                              ? {
                                    kind: ThreadItemKind.UserMessage,
                                    status: ThreadItemStatus.Completed,
                                    title: '',
                                    text: userText,
                                    providerItemId: null,
                                }
                              : undefined;
                    return converted
                        ? [
                              {
                                  ...converted,
                                  turnId: turn.id,
                                  createdAt: toJsDate(
                                      createUtcFullDate(
                                          check.isObject(item) && check.isNumber(item.startedAtMs)
                                              ? item.startedAtMs
                                              : (turn.startedAt ?? thread.createdAt) * 1000,
                                      ),
                                  ),
                              },
                          ]
                        : [];
                });
            }),
            title: thread.name || fallbackTitle,
            firstTimestamp: toUtcIsoString(createUtcFullDate(thread.createdAt * 1000)),
            lastTimestamp: toUtcIsoString(createUtcFullDate(thread.updatedAt * 1000)),
        };
    });
}

/** Starts Codex to read its sessions, or resolves undefined when it never ran here or won't start. */
async function startCodexReader() {
    if (!(await stat(join(homedir(), '.codex', 'sessions')).catch(() => undefined))) {
        return undefined;
    }
    const rpc = await startCodexRpc({
        cwd: homedir(),
        onNotification() {},
        onRequest(method) {
            throw new Error(`Converting from Build v1 doesn't answer Codex's ${method} request.`);
        },
        onExit() {},
    });
    try {
        await initializeCodexRpc(rpc);
        return rpc;
    } catch (error) {
        rpc.stop();
        log.warning(
            `Codex didn't start, so threads converted from Build v1 leave out Codex conversations: ${extractErrorMessage(error)}`,
        );
        return undefined;
    }
}

/**
 * The folder's pane group with its AI tabs replaced by one tab for the thread's chat, where the
 * first AI tab was. Undefined when that leaves a group with no tabs.
 */
export function replaceAiTabs({
    state,
    threadId,
}: Readonly<{state: Readonly<PaneGroupState>; threadId: string}>): PaneGroupState | undefined {
    const chatTab = {
        id: `${aiChatPaneId}:${threadId}`,
        kind: aiChatPaneId,
        state: {
            threadId,
        },
    };
    function isAiTab(tabId: string) {
        return state.tabLayout.tabs[tabId]?.kind === legacyAiPaneKind;
    }
    const chatGroupId =
        getObjectTypedKeys(state.tabLayout.groups).find((groupId) => {
            return state.tabLayout.groups[groupId]?.tabIds.some(isAiTab);
        }) || getObjectTypedKeys(state.tabLayout.groups)[0];
    if (!chatGroupId) {
        return undefined;
    }
    const groups = mapObjectValues(state.tabLayout.groups, (groupId, group) => {
        const tabIds = group.tabIds.filter((tabId) => !isAiTab(tabId));
        return {
            tabIds:
                groupId === chatGroupId
                    ? tabIds.toSpliced(Math.max(group.tabIds.findIndex(isAiTab), 0), 0, chatTab.id)
                    : tabIds,
        };
    });
    if (getObjectTypedValues(groups).some((group) => !group.tabIds.length)) {
        return undefined;
    }
    return {
        tabLayout: {
            ...state.tabLayout,
            tabs: {
                ...typedObjectFromEntries(
                    getObjectTypedEntries(state.tabLayout.tabs).filter(([tabId]) => {
                        return !isAiTab(tabId);
                    }),
                ),
                [chatTab.id]: chatTab,
            },
            groups,
        },
        tabSelection: {
            activeGroupId: chatGroupId,
            activeTabIdByGroup: mapObjectValues(groups, (groupId, group) => {
                const previousTabId = state.tabSelection?.activeTabIdByGroup[groupId];
                return groupId === chatGroupId
                    ? chatTab.id
                    : previousTabId && group.tabIds.includes(previousTabId)
                      ? previousTabId
                      : assertWrap.isDefined(group.tabIds[0]);
            }),
        },
    };
}

/**
 * Gives the worktree a thread holding the conversations of its Build v1 AI tabs, which resumes the
 * latest one, and moves the worktree's tabs into the thread's.
 */
async function convertWorktree({
    prismaClient,
    host,
    folder,
    repoPath,
    claimedSessionIds,
    codexRpc,
}: Readonly<{
    prismaClient: PrismaClient;
    host: PluginServerHost;
    folder: string;
    repoPath: string;
    claimedSessionIds: ReadonlyArray<string>;
    codexRpc: CodexRpc | undefined;
}>) {
    const threadId = createCuid2();
    const realFolder = await realpath(folder);
    const projectKey = createClaudeProjectKey(realFolder);
    const projectDir = join(findClaudeConfigDir(), 'projects', projectKey);
    const sessionIds = (await readdir(projectDir).catch((): string[] => []))
        .map((fileName) => extractExtension(fileName))
        .filter(({extension, basename}) => {
            return extension === '.jsonl' && claimedSessionIds.includes(basename);
        })
        .map(({basename}) => basename);
    const claudeSessions = await Promise.all(
        sessionIds.map(async (sessionId) => {
            const entries = await readTranscript(join(projectDir, `${sessionId}.jsonl`));
            const timestamps = entries
                .map((entry) => entry.timestamp)
                .filter(check.isString)
                .toSorted();
            return {
                provider: AiProvider.Claude,
                sessionId,
                items: buildItems(entries),
                title: readTitle({
                    entries,
                    fallback: basename(folder),
                }),
                firstTimestamp: timestamps[0],
                lastTimestamp: timestamps.at(-1),
            };
        }),
    );
    const codexSessions = codexRpc
        ? await readCodexSessions({
              rpc: codexRpc,
              folder: realFolder,
              fallbackTitle: basename(folder),
          }).catch((error: unknown) => {
              log.warning(
                  `Reading the Codex sessions of ${folder} failed, so its thread converted from Build v1 leaves them out: ${extractErrorMessage(error)}`,
              );
              return [];
          })
        : [];
    const sessions = [
        ...claudeSessions,
        ...codexSessions,
    ]
        .filter((session) => session.items.length)
        .toSorted((first, second) => {
            return (first.lastTimestamp || '').localeCompare(second.lastTimestamp || '');
        });
    const latest = sessions.at(-1);
    if (latest?.provider === AiProvider.Claude) {
        /** Clears what an interrupted earlier conversion stored, which `append` would keep. */
        await prismaClient.claudeTranscriptEntry.deleteMany({
            where: {
                sessionId: latest.sessionId,
            },
        });
        const subagentFiles = (
            await readDirRecursive(join(projectDir, latest.sessionId)).catch((): string[] => [])
        )
            .map((path) => extractExtension(path))
            .filter(({extension}) => extension === '.jsonl');
        await awaitedForEach(
            [
                {
                    path: join(projectDir, `${latest.sessionId}.jsonl`),
                    key: {
                        projectKey,
                        sessionId: latest.sessionId,
                    },
                },
                ...subagentFiles.map(({dirname, basename}) => {
                    return {
                        path: join(projectDir, latest.sessionId, `${dirname}${basename}.jsonl`),
                        key: {
                            projectKey,
                            sessionId: latest.sessionId,
                            subpath: `${dirname}${basename}`,
                        },
                    };
                }),
            ],
            async ({path, key}) => {
                await awaitedForEach(
                    chunkArray(await readTranscript(path), {
                        chunkSize: 1000,
                    }),
                    async (chunk) => {
                        await createClaudeSessionStore(prismaClient).append(key, chunk);
                    },
                );
            },
        );
    }
    const items: ConvertedItem[] = latest
        ? sessions.flatMap((session) => {
              return [
                  ...session.items,
                  {
                      kind: ThreadItemKind.Notice,
                      status: ThreadItemStatus.Completed,
                      title: '',
                      text:
                          sessions.length === 1
                              ? `Moved from Build v1's AI tab. This thread resumes ${providerLabels[session.provider]} session ${session.sessionId}.`
                              : session === latest
                                ? `Moved from Build v1, where this folder had ${sessions.length} AI tabs. This thread holds all of their conversations and resumes ${providerLabels[session.provider]} session ${session.sessionId}, the one just above. The AI doesn't remember the earlier ones.`
                                : `Moved from a separate Build v1 AI tab: "${session.title}", ${providerLabels[session.provider]} session ${session.sessionId}. This thread doesn't resume that session, so the AI doesn't remember this conversation.`,
                      providerItemId: null,
                      turnId: session.items.at(-1)?.turnId || randomUUID(),
                      createdAt: toJsDate(createUtcFullDate(session.lastTimestamp || Date.now())),
                  },
              ];
          })
        : [
              {
                  kind: ThreadItemKind.Notice,
                  status: ThreadItemStatus.Completed,
                  title: '',
                  text: 'Moved from Build v1. This folder had no AI conversation to bring over.',
                  providerItemId: null,
                  turnId: randomUUID(),
                  createdAt: toJsDate(getNowInUtcTimezone()),
              },
          ];
    /** A resumed session repeats the earlier session's messages, under the same ids. */
    const firstIndexByProviderItemId = new Map(
        items
            .map((item, index) => {
                return [
                    item.providerItemId,
                    index,
                ] as const;
            })
            .toReversed(),
    );
    const modelDefault = resolveThreadModelDefault({
        defaults: readModelDefaults(await host.loadSettings()),
        folder: repoPath,
        origin: ThreadOrigin.User,
    });
    /** The thread resumes its latest session's provider, whatever provider new threads default to. */
    const provider = latest?.provider ?? modelDefault.provider;
    const providerDefault = modelDefault.provider === provider ? modelDefault : undefined;
    const createdAt = sessions
        .map((session) => session.firstTimestamp)
        .filter(check.isString)
        .toSorted()[0];
    await prismaClient.thread.create({
        data: {
            id: threadId,
            createdAt: toJsDate(createUtcFullDate(createdAt || Date.now())),
            updatedAt: toJsDate(createUtcFullDate(latest?.lastTimestamp || Date.now())),
            repoPath,
            cwd: folder,
            provider,
            model: providerDefault?.model || '',
            effort: providerDefault?.effort ?? null,
            speedTier: providerDefault?.speedTier || null,
            runtimeMode: RuntimeMode.FullAccess,
            title: latest?.title || basename(folder),
            status: ThreadStatus.Idle,
            providerSessionId: latest?.sessionId ?? null,
            hasCustomTitle: true,
            origin: ThreadOrigin.User,
            items: {
                createMany: {
                    data: items
                        .filter((item, index) => {
                            return (
                                !item.providerItemId ||
                                firstIndexByProviderItemId.get(item.providerItemId) === index
                            );
                        })
                        .map((item, order) => {
                            return {
                                ...item,
                                order,
                                updatedAt: item.createdAt,
                            };
                        }),
                },
            },
        },
        select: {
            id: true,
        },
    });
    await host.moveFolderPaneGroup({
        folder,
        scope: toThreadScope(threadId),
        changeLayout(state) {
            return replaceAiTabs({
                state,
                threadId,
            });
        },
    });
    return threadId;
}

/**
 * Converts each worktree that Build v1 ran AI tabs in, which has no thread yet, into a thread. The
 * Claude sessions those tabs ran and the worktree's Codex sessions become the thread's history, and
 * the latest one is the session it resumes. Runs until every worktree converts once, then never
 * again.
 */
export async function convertBuildV1Worktrees({
    prismaClient,
    host,
    dataDir,
    onThreadCreated,
}: Readonly<{
    prismaClient: PrismaClient;
    host: PluginServerHost;
    dataDir: string;
    onThreadCreated(threadId: string): Promise<void>;
}>) {
    const markerPath = join(dataDir, conversionMarkerFileName);
    if (await stat(markerPath).catch(() => undefined)) {
        return;
    }
    const folders = await host.listFolders();
    /**
     * Empty when the app has neither scanned nor saved a folder list yet. Converting nothing then
     * would write the marker and skip every worktree for good, so this tries again next start
     * instead. A saved list from a past run is enough: Build v1 only ran AI tabs in folders the app
     * had listed and saved.
     */
    if (!folders.length) {
        return;
    }
    const [
        threads,
        worktreeNotices,
        claimedSessionIds,
    ] = await Promise.all([
        prismaClient.thread.findMany({
            select: {
                cwd: true,
                providerSessionId: true,
            },
        }),
        /** A worktree Build made for a thread that since left it. */
        prismaClient.threadItem.findMany({
            where: {
                kind: ThreadItemKind.Notice,
                OR: [
                    {
                        text: {
                            startsWith: 'Moved to a new worktree at ',
                        },
                    },
                    {
                        text: {
                            startsWith: 'Unarchived into a new worktree of branch ',
                        },
                    },
                ],
            },
            select: {
                text: true,
            },
        }),
        readClaimedSessionIds(),
    ]);
    const threadSessionIds = threads.map((thread) => thread.providerSessionId);
    const unusedSessionIds = claimedSessionIds.filter((sessionId) => {
        return !threadSessionIds.includes(sessionId);
    });
    const worktrees = folders.filter((info) => {
        return (
            info.parentRepoPath &&
            !threads.some((thread) => thread.cwd === info.path) &&
            !worktreeNotices.some(({text}) => {
                return (
                    text === `Moved to a new worktree at ${info.path}.` ||
                    (text.startsWith('Unarchived into a new worktree of branch ') &&
                        text.endsWith(` at ${info.path}.`))
                );
            })
        );
    });
    const existingWorktrees = (
        await Promise.all(
            worktrees.map(async (info) => {
                return (await stat(info.path).catch(() => undefined)) ? [info] : [];
            }),
        )
    ).flat();
    const codexRpc = existingWorktrees.length ? await startCodexReader() : undefined;
    const results = await awaitedBlockingMap(existingWorktrees, async (info) => {
        try {
            await onThreadCreated(
                await convertWorktree({
                    prismaClient,
                    host,
                    folder: info.path,
                    repoPath: normalizePath(assertWrap.isTruthy(info.parentRepoPath)),
                    claimedSessionIds: unusedSessionIds,
                    codexRpc,
                }),
            );
            return true;
        } catch (error) {
            log.warning(
                `Converting ${info.path} from Build v1 failed: ${extractErrorMessage(error)}`,
            );
            return false;
        }
    }).finally(() => codexRpc?.stop());
    if (results.every(Boolean)) {
        await writeFile(markerPath, toUtcIsoString(getNowInUtcTimezone()));
    }
}
