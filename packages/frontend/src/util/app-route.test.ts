import {folderInfoShape, type FolderInfo} from '@agent-storm/common';
import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {resolveAppRoute} from './app-route.js';
import {ActivityId, orderedActivityIds, type AppRoute} from './router.js';

function createFolder(overrides: Readonly<Partial<FolderInfo>>): FolderInfo {
    return {
        ...folderInfoShape.default,
        ...overrides,
    };
}

const standalone = createFolder({
    path: '/repos/solo',
    name: 'solo',
});
const worktreeRoot = createFolder({
    path: '/repos/multi',
    name: 'multi',
    isWorktreeRoot: true,
});
const worktree = createFolder({
    path: '/repos/multi/feature',
    name: 'feature',
    parentRepoPath: worktreeRoot.path,
});
const folderInfo = new Map(
    [
        standalone,
        worktreeRoot,
        worktree,
    ].map((folder) => {
        return [
            folder.path,
            folder,
        ];
    }),
);
const pullRequest = {
    owner: 'acme',
    repoName: 'widgets',
    number: 7,
};

function resolve(
    {paths}: Readonly<Pick<AppRoute, 'paths'>>,
    overrides: Readonly<Partial<Parameters<typeof resolveAppRoute>[0]>> = {},
) {
    return resolveAppRoute({
        route: {
            paths,
            search: undefined,
            hash: undefined,
        },
        folderInfo,
        enabledActivityIds: orderedActivityIds,
        reviewablePrs: [
            pullRequest,
        ],
        rememberedFolderPath: undefined,
        rememberedPullRequestKey: undefined,
        ...overrides,
    });
}

describe(resolveAppRoute.name, () => {
    it('selects a standalone repo and a worktree from their paths', () => {
        assert.deepEquals(
            [
                resolve({
                    paths: [
                        ActivityId.Build,
                        'solo',
                    ],
                }),
                resolve({
                    paths: [
                        ActivityId.Build,
                        'multi',
                        'feature',
                    ],
                }),
            ].map(({activeFolder, redirect}) => {
                return {
                    activeFolder: activeFolder?.path,
                    redirect,
                };
            }),
            [
                {
                    activeFolder: standalone.path,
                    redirect: undefined,
                },
                {
                    activeFolder: worktree.path,
                    redirect: undefined,
                },
            ],
        );
    });

    it('sends an unresolvable Build path back to the bare Build route, but not before folders load', () => {
        const route = {
            paths: [
                ActivityId.Build,
                'multi',
            ],
        } as const;
        assert.deepEquals(
            [
                resolve(route).redirect,
                resolve(route, {
                    folderInfo: new Map(),
                }).redirect,
            ],
            [
                {
                    route: {
                        paths: [ActivityId.Build],
                    },
                    replace: false,
                },
                undefined,
            ],
        );
    });

    it('only selects a pull request that is still reviewable', () => {
        assert.deepEquals(
            [
                resolve({
                    paths: [
                        ActivityId.Review,
                        'acme',
                        'widgets',
                        '7',
                    ],
                }).activePullRequest,
                resolve({
                    paths: [
                        ActivityId.Review,
                        'acme',
                        'widgets',
                        '8',
                    ],
                }).activePullRequest,
                resolve(
                    {
                        paths: [
                            ActivityId.Review,
                            'acme',
                            'widgets',
                            '7',
                        ],
                    },
                    {
                        reviewablePrs: undefined,
                    },
                ).activePullRequest,
            ],
            [
                'acme/widgets/7',
                undefined,
                undefined,
            ],
        );
    });

    it('restores the remembered folder on the bare Build route', () => {
        assert.deepEquals(
            resolve(
                {
                    paths: [ActivityId.Build],
                },
                {
                    rememberedFolderPath: worktree.path,
                },
            ).redirect,
            {
                route: {
                    paths: [
                        ActivityId.Build,
                        'multi',
                        'feature',
                    ],
                },
                replace: true,
            },
        );
    });

    it('leaves an activity that is turned off, once the layout has loaded', () => {
        assert.deepEquals(
            [
                resolve(
                    {
                        paths: [ActivityId.Debug],
                    },
                    {
                        enabledActivityIds: [
                            ActivityId.Build,
                            ActivityId.Review,
                        ],
                    },
                ).redirect,
                resolve(
                    {
                        paths: [ActivityId.Debug],
                    },
                    {
                        enabledActivityIds: undefined,
                    },
                ).redirect,
            ],
            [
                {
                    route: {
                        paths: [ActivityId.Build],
                    },
                    replace: true,
                },
                undefined,
            ],
        );
    });
});
