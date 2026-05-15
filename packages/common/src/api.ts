import {AnyOrigin, defineService, HttpMethod} from '@rest-vir/define-service';
import {defineShape, enumShape, nullableShape, tupleShape} from 'object-shape-tester';
import {PaneKind, PaneStatus} from './enums.js';

const port = 3000;

const stringMessageShape = defineShape('');

const ptySearchParamsShape = defineShape({
    folder: tupleShape(''),
    kind: tupleShape(enumShape(PaneKind)),
});

const repoConfigShape = defineShape({
    path: '',
    postWorktreeCmd: nullableShape(''),
});

const configShape = defineShape({
    aiCmd: 'claude',
    postWorktreeCmd: nullableShape(''),
    repos: [repoConfigShape],
    hiddenAiPane: [''],
});

const folderInfoShape = defineShape({
    path: '',
    name: '',
    parentRepoPath: nullableShape(''),
    isWorktreeRoot: false,
    aiHidden: false,
    branch: nullableShape(''),
    git: {
        dirty: false,
        unpushed: false,
    },
    prUrl: nullableShape(''),
    prMerged: false,
    panes: {
        ai: enumShape(PaneStatus),
        shell: enumShape(PaneStatus),
    },
});

const foldersResponseShape = defineShape({
    folders: [folderInfoShape],
});

const folderActionRequestShape = defineShape({
    folder: '',
});

const paneActionRequestShape = defineShape({
    folder: '',
    kind: enumShape(PaneKind),
});

const createWorktreeRequestShape = defineShape({
    repoPath: '',
    name: '',
});

const deleteWorktreeRequestShape = defineShape({
    worktreePath: '',
});

const okResponseShape = defineShape({
    ok: true,
});

export const agentStormService = defineService({
    serviceName: 'agent-storm',
    serviceOrigin: `http://localhost:${port}`,
    requiredClientOrigin: AnyOrigin,
    endpoints: {
        '/config': {
            methods: {
                [HttpMethod.Get]: true,
                [HttpMethod.Put]: true,
            },
            requestDataShape: nullableShape(configShape),
            responseDataShape: configShape,
        },
        '/folders': {
            methods: {
                [HttpMethod.Get]: true,
            },
            requestDataShape: undefined,
            responseDataShape: foldersResponseShape,
        },
        '/worktrees/create': {
            methods: {
                [HttpMethod.Post]: true,
            },
            requestDataShape: createWorktreeRequestShape,
            responseDataShape: okResponseShape,
        },
        '/worktrees/delete': {
            methods: {
                [HttpMethod.Post]: true,
            },
            requestDataShape: deleteWorktreeRequestShape,
            responseDataShape: okResponseShape,
        },
        '/panes/restart': {
            methods: {
                [HttpMethod.Post]: true,
            },
            requestDataShape: paneActionRequestShape,
            responseDataShape: okResponseShape,
        },
        '/panes/kill': {
            methods: {
                [HttpMethod.Post]: true,
            },
            requestDataShape: folderActionRequestShape,
            responseDataShape: okResponseShape,
        },
        '/daemon/restart': {
            methods: {
                [HttpMethod.Post]: true,
            },
            requestDataShape: undefined,
            responseDataShape: okResponseShape,
        },
    },
    webSockets: {
        '/pty': {
            messageFromClientShape: stringMessageShape,
            messageFromHostShape: stringMessageShape,
            searchParamsShape: ptySearchParamsShape,
        },
    },
});

export const defaultConfig = configShape.default;

export type Config = typeof configShape.runtimeType;
export type RepoConfig = typeof repoConfigShape.runtimeType;
export type FolderInfo = typeof folderInfoShape.runtimeType;
