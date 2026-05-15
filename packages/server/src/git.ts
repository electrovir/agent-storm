import {execFile} from 'node:child_process';
import {lstat, readdir, stat} from 'node:fs/promises';
import {join} from 'node:path';
import {promisify} from 'node:util';

const exec = promisify(execFile);

type GitInfo = {
    branch: string | null;
    dirty: boolean;
    unpushed: boolean;
};

const cleanGitInfo: GitInfo = {
    branch: null,
    dirty: false,
    unpushed: false,
};

export async function getGitInfo(folder: string): Promise<GitInfo> {
    const branch = await runGit(folder, [
        'rev-parse',
        '--abbrev-ref',
        'HEAD',
    ]).then((output) => output?.trim() || null);

    if (!branch || branch === 'HEAD') {
        return cleanGitInfo;
    }

    const status = await runGit(folder, [
        'status',
        '--porcelain',
    ]);
    const dirty = !!status && status.length > 0;

    const hasUpstream = await runGit(folder, [
        'rev-parse',
        '--abbrev-ref',
        '--symbolic-full-name',
        '@{upstream}',
    ]).then((output) => output != undefined);

    const unpushed = hasUpstream
        ? await runGit(folder, [
              'log',
              '--oneline',
              '@{upstream}..HEAD',
          ]).then((output) => !!output && output.length > 0)
        : false;

    return {
        branch,
        dirty,
        unpushed,
    };
}

async function runGit(cwd: string, args: ReadonlyArray<string>): Promise<string | undefined> {
    const result = await exec('git', [...args], {cwd}).catch(() => undefined);
    return result?.stdout;
}

export async function isWorktreeRoot(folder: string): Promise<boolean> {
    const entries = await readdir(folder).catch(() => []);
    const checks = await Promise.all(
        entries.map(async (name) => {
            if (name.startsWith('.')) {
                return false;
            }
            const childPath = join(folder, name);
            const childStat = await stat(childPath).catch(() => undefined);
            if (!childStat?.isDirectory()) {
                return false;
            }
            const dotGit = join(childPath, '.git');
            const dotGitStat = await lstat(dotGit).catch(() => undefined);
            if (!dotGitStat) {
                return false;
            }
            if (dotGitStat.isFile()) {
                return true;
            }
            if (dotGitStat.isDirectory()) {
                const worktreesDir = join(dotGit, 'worktrees');
                const worktreesStat = await stat(worktreesDir).catch(() => undefined);
                return worktreesStat?.isDirectory() || false;
            }
            return false;
        }),
    );
    return checks.some((isWorktree) => isWorktree);
}

export async function listWorktreeChildren(folder: string): Promise<string[]> {
    const entries = await readdir(folder).catch(() => []);
    const results = await Promise.all(
        entries.map(async (name) => {
            if (name.startsWith('.')) {
                return undefined;
            }
            const childPath = join(folder, name);
            const childStat = await stat(childPath).catch(() => undefined);
            if (!childStat?.isDirectory()) {
                return undefined;
            }
            if (await isBareGitRepo(childPath)) {
                return undefined;
            }
            const dotGit = join(childPath, '.git');
            const dotGitStat = await lstat(dotGit).catch(() => undefined);
            return dotGitStat ? childPath : undefined;
        }),
    );
    return results.filter((path): path is string => !!path);
}

async function isBareGitRepo(folder: string): Promise<boolean> {
    const [
        headStat,
        refsStat,
        objectsStat,
    ] = await Promise.all([
        stat(join(folder, 'HEAD')).catch(() => undefined),
        stat(join(folder, 'refs')).catch(() => undefined),
        stat(join(folder, 'objects')).catch(() => undefined),
    ]);
    return !!headStat?.isFile() && !!refsStat?.isDirectory() && !!objectsStat?.isDirectory();
}

export async function addWorktree({
    repoPath,
    name,
}: Readonly<{
    repoPath: string;
    name: string;
}>): Promise<void> {
    const children = await listWorktreeChildren(repoPath);
    const anyChild = children[0];
    if (!anyChild) {
        throw new Error(`No existing worktree found in ${repoPath} to base a new worktree on.`);
    }
    await exec(
        'git',
        [
            'worktree',
            'add',
            `../${name}`,
        ],
        {cwd: anyChild},
    );
}

export async function removeWorktree({
    worktreePath,
}: Readonly<{worktreePath: string}>): Promise<void> {
    const parent = join(worktreePath, '..');
    const children = await listWorktreeChildren(parent);
    const sibling = children.find((path) => path !== worktreePath);
    if (!sibling) {
        throw new Error(`Refusing to remove last worktree at ${worktreePath}.`);
    }
    await exec(
        'git',
        [
            'worktree',
            'remove',
            worktreePath,
            '--force',
        ],
        {cwd: sibling},
    );
}

let cachedGhAvailable: boolean | undefined;

async function isGhAvailable(): Promise<boolean> {
    if (cachedGhAvailable != undefined) {
        return cachedGhAvailable;
    }
    cachedGhAvailable = await exec('gh', [
        'auth',
        'status',
    ])
        .then(() => true)
        .catch(() => false);
    return cachedGhAvailable;
}

export type PrInfo = {
    url: string;
    merged: boolean;
};

const sevenDaysSeconds = 7 * 24 * 60 * 60;

export async function getPrInfo(folder: string, branch: string | null): Promise<PrInfo | null> {
    if (!branch || !(await isGhAvailable())) {
        return null;
    }
    const result = await exec(
        'gh',
        [
            'pr',
            'view',
            branch,
            '--json',
            'url,state,mergedAt',
        ],
        {cwd: folder},
    ).catch(() => undefined);
    if (!result) {
        return null;
    }
    const parsed = JSON.parse(result.stdout) as {
        url?: string;
        state?: string;
        mergedAt?: string | null;
    };
    if (parsed.state === 'CLOSED') {
        return null;
    }
    if (!parsed.url) {
        return null;
    }
    const merged =
        parsed.state === 'MERGED' &&
        !!parsed.mergedAt &&
        (Date.now() - new Date(parsed.mergedAt).getTime()) / 1000 <= sevenDaysSeconds;
    return {
        url: parsed.url,
        merged,
    };
}
