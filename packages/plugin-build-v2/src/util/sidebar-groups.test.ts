import {folderInfoShape, PrStatus, SidebarSorting} from '@agent-storm/common';
import {assert, assertWrap} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {AiProvider, RuntimeMode, ThreadOrigin, ThreadStatus, type Thread} from '../build-v2-api.js';
import {arrangeRepoGroups} from './sidebar-groups.js';
import {type ThreadRepoGroup} from './thread-timeline.js';

function createGroup({
    name,
    threadTitle,
    updatedAt,
}: Readonly<{
    name: string;
    threadTitle: string | undefined;
    updatedAt: number;
}>): ThreadRepoGroup {
    const path = `/repos/${name}`;
    const thread: Thread = {
        id: name,
        repoPath: path,
        cwd: path,
        worktreeBranch: null,
        provider: AiProvider.Claude,
        model: '',
        runtimeMode: RuntimeMode.FullAccess,
        title: threadTitle || '',
        status: ThreadStatus.Idle,
        hasUnreadReply: false,
        isPriority: false,
        isAskingQuestion: false,
        backgroundTaskCount: 0,
        origin: ThreadOrigin.User,
        userMessageCount: 0,
        lastUserMessageAt: 0,
        createdAt: 0,
        updatedAt,
    };
    return {
        repo: {
            path,
            name,
        },
        threads: threadTitle
            ? [
                  thread,
              ]
            : [],
    };
}

const groups = [
    createGroup({
        name: 'beta',
        threadTitle: 'Fix login',
        updatedAt: 1,
    }),
    createGroup({
        name: 'alpha',
        threadTitle: 'Add search',
        updatedAt: 2,
    }),
    createGroup({
        name: 'gamma',
        threadTitle: 'Old work',
        updatedAt: 3,
    }),
    createGroup({
        name: 'hotel',
        threadTitle: undefined,
        updatedAt: 0,
    }),
    createGroup({
        name: 'echo',
        threadTitle: undefined,
        updatedAt: 0,
    }),
];

function arrangedNames(params: Readonly<Omit<Parameters<typeof arrangeRepoGroups>[0], 'groups'>>) {
    return arrangeRepoGroups({
        ...params,
        groups,
    }).map((group) => group.repo.name);
}

describe(arrangeRepoGroups.name, () => {
    it('hides folders without threads or recent use and sorts the rest', () => {
        assert.deepEquals(
            arrangedNames({
                folderInfo: new Map(),
                archivedThreadIds: [],
                repos: [
                    {
                        path: '/repos/alpha',
                        lastInteractedAtMs: Date.now(),
                    },
                    {
                        path: '/repos/beta',
                        lastInteractedAtMs: Date.now(),
                    },
                    {
                        path: '/repos/hotel',
                        lastInteractedAtMs: Date.now(),
                    },
                    {
                        path: '/repos/echo',
                    },
                ],
                sorting: SidebarSorting.Name,
                onlyShowRecent: true,
                searchQuery: '',
            }),
            [
                'alpha',
                'beta',
                'gamma',
                'hotel',
            ],
        );
    });
    it('searches hidden folders by folder name or thread title', () => {
        assert.deepEquals(
            arrangedNames({
                folderInfo: new Map(),
                archivedThreadIds: [],
                repos: [],
                sorting: SidebarSorting.Activity,
                onlyShowRecent: true,
                searchQuery: ' A ',
            }),
            [
                'alpha',
                'beta',
                'gamma',
            ],
        );
        assert.deepEquals(
            arrangedNames({
                folderInfo: new Map(),
                archivedThreadIds: [],
                repos: [],
                sorting: SidebarSorting.Activity,
                onlyShowRecent: false,
                searchQuery: 'login',
            }),
            [
                'beta',
            ],
        );
    });
    it('sorts folders by name with folders lacking active threads last', () => {
        assert.deepEquals(
            arrangedNames({
                folderInfo: new Map(),
                archivedThreadIds: [
                    'beta',
                ],
                repos: [],
                sorting: SidebarSorting.Activity,
                onlyShowRecent: false,
                searchQuery: '',
            }),
            [
                'alpha',
                'gamma',
                'beta',
                'echo',
                'hotel',
            ],
        );
    });
    it('sorts threads by status ring within alphabetical folders', () => {
        const alpha = createGroup({
            name: 'alpha',
            threadTitle: 'Approved',
            updatedAt: 1,
        });
        const threadStatuses = [
            PrStatus.Approved,
            PrStatus.Merged,
            PrStatus.ChecksFailed,
        ];
        const threads = threadStatuses.map((prStatus) => {
            return {
                ...assertWrap.isDefined(alpha.threads[0]),
                id: `thread-${prStatus}`,
                cwd: `/worktrees/${prStatus}`,
            };
        });
        const arranged = arrangeRepoGroups({
            groups: [
                ...groups.filter((group) => group.repo.name !== 'alpha'),
                {
                    ...alpha,
                    threads,
                },
            ],
            folderInfo: new Map(
                threadStatuses.map((prStatus) => {
                    const path = `/worktrees/${prStatus}`;
                    return [
                        path,
                        {
                            ...folderInfoShape.default,
                            path,
                            prUrl: `https://github.com/owner/repo/pull/${prStatus}`,
                            prStatus,
                        },
                    ];
                }),
            ),
            archivedThreadIds: [
                'beta',
            ],
            repos: [],
            sorting: SidebarSorting.Status,
            onlyShowRecent: false,
            searchQuery: '',
        });
        assert.deepEquals(
            arranged.map((group) => {
                return {
                    name: group.repo.name,
                    threadIds: group.threads.map((thread) => thread.id),
                };
            }),
            [
                {
                    name: 'alpha',
                    threadIds: [
                        `thread-${PrStatus.Merged}`,
                        `thread-${PrStatus.ChecksFailed}`,
                        `thread-${PrStatus.Approved}`,
                    ],
                },
                {
                    name: 'gamma',
                    threadIds: [
                        'gamma',
                    ],
                },
                {
                    name: 'beta',
                    threadIds: [
                        'beta',
                    ],
                },
                {
                    name: 'echo',
                    threadIds: [],
                },
                {
                    name: 'hotel',
                    threadIds: [],
                },
            ],
        );
    });
});
