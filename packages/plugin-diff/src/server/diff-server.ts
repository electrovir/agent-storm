import {definePluginServer} from '@agent-storm/core/server';
import {normalizePath} from 'agent-storm-util';
import {diffApi} from '../diff-api.js';
import {
    discardFileChanges,
    discardHunkChanges,
    discardUnstagedChanges,
    getDiffFileContents,
    getDiffStatus,
    getPullRequestStatus,
    moveHunkAcrossIndex,
    setFileStaged,
    setSideStaged,
} from './git-diff.js';

const ok = {
    ok: true,
} as const;

export default definePluginServer({
    api: diffApi,
    start() {
        return {
            calls: {
                async readStatus({folder}) {
                    return await getDiffStatus(normalizePath(folder));
                },
                async readPullRequestStatus(request) {
                    return await getPullRequestStatus({
                        ...request,
                        folder: normalizePath(request.folder),
                    });
                },
                async readFile(request) {
                    return await getDiffFileContents({
                        ...request,
                        folder: normalizePath(request.folder),
                    });
                },
                async stageFile(request) {
                    await setFileStaged({
                        ...request,
                        folder: normalizePath(request.folder),
                    });
                    return ok;
                },
                async discardFile(request) {
                    await discardFileChanges({
                        ...request,
                        folder: normalizePath(request.folder),
                    });
                    return ok;
                },
                async stageAll(request) {
                    await setSideStaged({
                        ...request,
                        folder: normalizePath(request.folder),
                    });
                    return ok;
                },
                async discardUnstaged({folder}) {
                    await discardUnstagedChanges(normalizePath(folder));
                    return ok;
                },
                async stageHunk(request) {
                    await moveHunkAcrossIndex({
                        ...request,
                        folder: normalizePath(request.folder),
                    });
                    return ok;
                },
                async discardHunk(request) {
                    await discardHunkChanges({
                        ...request,
                        folder: normalizePath(request.folder),
                    });
                    return ok;
                },
            },
        };
    },
});
