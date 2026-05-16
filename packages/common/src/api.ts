import {AnyOrigin, defineService, HttpMethod} from '@rest-vir/define-service';
import {defineShape, enumShape, nullableShape, tupleShape} from 'object-shape-tester';
import {PaneKind, PaneStatus} from './enums.js';

const port = 3000;

const stringMessageShape = defineShape('');

const ptySearchParamsShape = defineShape({
    folder: tupleShape(''),
    kind: tupleShape(enumShape(PaneKind)),
});

/**
 * The WebSocket upgrade can't carry an `Authorization` header from a browser, but it *can* carry
 * subprotocols. The auth bearer rides in `Sec-WebSocket-Protocol`; the server validates it and
 * sends back this same value to complete the upgrade handshake.
 */
const ptyProtocolsShape = defineShape(tupleShape(''));

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

const uploadRequestShape = defineShape({
    filename: '',
    dataBase64: '',
});

const uploadResponseShape = defineShape({
    path: '',
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
        '/uploads/create': {
            methods: {
                [HttpMethod.Post]: true,
            },
            requestDataShape: uploadRequestShape,
            responseDataShape: uploadResponseShape,
        },
    },
    webSockets: {
        '/pty': {
            messageFromClientShape: stringMessageShape,
            messageFromHostShape: stringMessageShape,
            searchParamsShape: ptySearchParamsShape,
            protocolsShape: ptyProtocolsShape,
        },
    },
});

export const defaultConfig = configShape.default;

export type Config = typeof configShape.runtimeType;
export type RepoConfig = typeof repoConfigShape.runtimeType;
export type FolderInfo = typeof folderInfoShape.runtimeType;
