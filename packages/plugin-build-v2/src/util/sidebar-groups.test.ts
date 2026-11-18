import {SidebarSorting} from '@agent-storm/common';
import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {AiProvider, RuntimeMode, ThreadStatus, type Thread} from '../build-v2-api.js';
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
                repoActivityAtMs: new Map(),
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
                repoActivityAtMs: new Map(),
                repos: [],
                sorting: SidebarSorting.Activity,
                onlyShowRecent: true,
                searchQuery: ' A ',
            }),
            [
                'gamma',
                'alpha',
                'beta',
            ],
        );
        assert.deepEquals(
            arrangedNames({
                folderInfo: new Map(),
                repoActivityAtMs: new Map(),
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
    it('keeps the activity of archived threads', () => {
        assert.deepEquals(
            arrangedNames({
                folderInfo: new Map(),
                repoActivityAtMs: new Map([
                    [
                        '/repos/beta',
                        4,
                    ],
                ]),
                repos: [],
                sorting: SidebarSorting.Activity,
                onlyShowRecent: false,
                searchQuery: '',
            }),
            [
                'beta',
                'gamma',
                'alpha',
                'echo',
                'hotel',
            ],
        );
    });
});
