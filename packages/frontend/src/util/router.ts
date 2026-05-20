import {SpaRouter, type FullSpaRoute} from 'spa-router-vir';

export type ValidPaths =
    | ['home']
    | ['add-repo']
    | ['add-worktree', string]
    | ['book', ...string[]];

export type AppRoute = FullSpaRoute<ValidPaths, undefined, undefined>;

export const router = new SpaRouter<ValidPaths, undefined, undefined>({
    sanitizeRoute(rawRoute) {
        const topLevelPath = rawRoute.paths[0];
        let paths: ValidPaths;
        if (topLevelPath === 'add-repo') {
            paths = ['add-repo'];
        } else if (topLevelPath === 'add-worktree') {
            // Second segment carries the URL-encoded path of the repo this worktree will be
            // created under. A missing segment can't satisfy the type, so fall through to home.
            const encodedRepo = rawRoute.paths[1];
            paths = encodedRepo ? ['add-worktree', encodedRepo] : ['home'];
        } else if (topLevelPath === 'book') {
            paths = ['book', ...rawRoute.paths.slice(1)] as ['book', ...string[]];
        } else {
            paths = ['home'];
        }
        return {
            paths,
            search: undefined,
            hash: undefined,
        };
    },
});
