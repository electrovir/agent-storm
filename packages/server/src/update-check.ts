import {type UpdateStatus} from '@agent-storm/common';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {loadConfig} from './config.js';
import {monorepoRoot} from './file-paths.js';

const exec = promisify(execFile);

/**
 * Branch the local checkout is compared against. Hardcoded to `dev` per project convention — that
 * is the default branch in `electrovir/agent-storm` and the one the user pulls from to update.
 */
const upstreamBranch = 'dev';

/**
 * Cache window for the remote SHA. The remote lookup costs one git protocol round-trip per call, so
 * a 10-minute TTL keeps polling traffic flat while still letting the banner clear within minutes of
 * a fresh push landing on `dev`. Negative results (network down, branch missing) honor the same TTL
 * so a sustained outage doesn't have us re-running `git ls-remote` every sidebar poll.
 */
const remoteShaCacheTtlMs = 10 * 60 * 1000;

const remoteShaState: {
    sha: string | undefined;
    fetchedAt: number;
    inFlight: Promise<string | undefined> | undefined;
} = {
    sha: undefined,
    fetchedAt: 0,
    inFlight: undefined,
};

/**
 * Run `git` inside the agent-storm checkout with all credential prompting disabled — a missing or
 * stale credential should fail fast, not hang waiting for the user to type something on the server
 * console (which they can't, because the server is headless).
 */
async function runGitInMonorepo(args: ReadonlyArray<string>): Promise<string | undefined> {
    try {
        const result = await exec('git', [...args], {
            cwd: monorepoRoot,
            env: {
                ...process.env,
                GIT_TERMINAL_PROMPT: '0',
                GIT_ASKPASS: 'true',
            },
        });
        return result.stdout.trim();
    } catch {
        return undefined;
    }
}

async function getCurrentSha(): Promise<string | undefined> {
    const sha = await runGitInMonorepo([
        'rev-parse',
        'HEAD',
    ]);
    return sha && /^[0-9a-f]{40}$/i.test(sha) ? sha : undefined;
}

async function fetchRemoteSha(): Promise<string | undefined> {
    const output = await runGitInMonorepo([
        'ls-remote',
        'origin',
        upstreamBranch,
    ]);
    if (!output) {
        return undefined;
    }
    /**
     * `git ls-remote` lines are `<sha>\t<ref>`. We asked for a single ref so the first whitespace-
     * separated chunk on the first line is the SHA we want. Validate it looks like a 40-char hex
     * before trusting it — anything else means git printed something unexpected and we should treat
     * the remote as unknown rather than show a misleading banner.
     */
    const [
        firstLine,
    ] = output.split('\n');
    const sha = firstLine?.split(/\s+/)[0];
    return sha && /^[0-9a-f]{40}$/i.test(sha) ? sha : undefined;
}

async function getRemoteSha(): Promise<string | undefined> {
    if (
        remoteShaState.fetchedAt > 0 &&
        Date.now() - remoteShaState.fetchedAt < remoteShaCacheTtlMs
    ) {
        return remoteShaState.sha;
    } else if (remoteShaState.inFlight) {
        return remoteShaState.inFlight;
    }
    remoteShaState.inFlight = fetchRemoteSha()
        .then((sha) => {
            remoteShaState.sha = sha;
            remoteShaState.fetchedAt = Date.now();
            return sha;
        })
        .finally(() => {
            remoteShaState.inFlight = undefined;
        });
    return remoteShaState.inFlight;
}

/**
 * Sentinel returned whenever the backend can't (or has been told not to) determine update status.
 * The sidebar treats any field of `null` as "no banner" — only `isUpToDate === false` triggers the
 * "pull from github to update" notice.
 */
const unknownUpdateStatus: UpdateStatus = {
    isUpToDate: null,
    currentSha: null,
    latestSha: null,
};

export async function getUpdateStatus(): Promise<UpdateStatus> {
    const config = await loadConfig().catch(() => undefined);
    if (config?.disableUpdateCheck) {
        return unknownUpdateStatus;
    }
    const [
        currentSha,
        remoteSha,
    ] = await Promise.all([
        getCurrentSha(),
        getRemoteSha(),
    ]);
    if (!currentSha || !remoteSha) {
        return {
            isUpToDate: null,
            currentSha: currentSha || null,
            latestSha: remoteSha || null,
        };
    }
    return {
        isUpToDate: currentSha === remoteSha,
        currentSha,
        latestSha: remoteSha,
    };
}
