// cspell:words askpass

import {type UpdateStatus} from '@agent-storm/common';
import {type AnyDuration, convertDuration} from 'date-vir';
import {monorepoRoot} from './file-paths.js';
import {runCommand} from './run-command.js';
import {loadSettings} from './settings.js';

/**
 * Branch the local checkout is compared against. Hardcoded to `dev` per project convention — that
 * is the default branch in `electrovir/agent-storm` and the one the user pulls from to update.
 */
const upstreamBranch = 'dev';

/**
 * Cache window for the remote SHA. The remote lookup costs one git protocol round-trip per call, so
 * a TTL of minutes keeps polling traffic flat while still letting the banner clear within minutes
 * of a fresh push landing on `dev`. Negative results (network down, branch missing) honor the same
 * TTL so a sustained outage doesn't have us re-running `git ls-remote` every sidebar poll.
 */
const remoteShaCacheTtl: AnyDuration = {
    minutes: 10,
};

const fullShaPattern = /^[0-9a-f]{40}$/i;

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
 * console (which they can't, because the server is headless). Resolves `undefined` when git fails.
 */
async function runGitInMonorepo(args: ReadonlyArray<string>) {
    try {
        const result = await runCommand('git', args, {
            cwd: monorepoRoot,
            env: {
                ...process.env,
                GIT_TERMINAL_PROMPT: '0',
                GIT_ASKPASS: 'true',
            },
            timeout: {
                seconds: 30,
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
    return sha && fullShaPattern.test(sha) ? sha : undefined;
}

/**
 * Resolve "is HEAD already at-or-ahead of the upstream tip?" via `git merge-base --is-ancestor`,
 * which exits 0 when the first arg is reachable from the second. That's exactly the relation we
 * want: HEAD is up-to-date iff every remote-`dev` commit is in HEAD's history (equal case →
 * trivially an ancestor; ahead case → HEAD has extra commits but still contains the remote tip).
 *
 * A non-zero exit means either "not an ancestor" (behind / diverged → banner is correct) OR the
 * object isn't in the local DB yet (user hasn't fetched since the most recent push). We can't tell
 * the two apart without a fetch, and fetching has side effects we don't want from a background
 * probe — so we conservatively treat both as "not up to date" and let the user `git fetch` if they
 * want the banner to update.
 */
async function isRemoteShaAncestorOfHead(remoteSha: string) {
    return (
        (await runGitInMonorepo([
            'merge-base',
            '--is-ancestor',
            remoteSha,
            'HEAD',
        ])) != undefined
    );
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
    return sha && fullShaPattern.test(sha) ? sha : undefined;
}

async function getRemoteSha(): Promise<string | undefined> {
    if (
        remoteShaState.fetchedAt > 0 &&
        Date.now() - remoteShaState.fetchedAt <
            convertDuration(remoteShaCacheTtl, {
                milliseconds: true,
            }).milliseconds
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
    const settings = await loadSettings().catch(() => undefined);
    if (settings?.disableUpdateCheck) {
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
        /**
         * Ancestor check instead of plain equality so a local branch that has merged + committed
         * past the remote tip ("ahead") still reads as up-to-date and the banner stays hidden.
         */
        isUpToDate: await isRemoteShaAncestorOfHead(remoteSha),
        currentSha,
        latestSha: remoteSha,
    };
}
