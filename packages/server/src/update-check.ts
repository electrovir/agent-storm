// cspell:words askpass

import {type UpdateStatus} from '@agent-storm/common';
import {extractErrorMessage, log} from '@augment-vir/common';
import {
    fetchLatestVersion,
    installRelease,
    isNewerVersion,
    isReleaseVersion,
    readActiveVersions,
    runCommand,
    versionsDir,
} from 'agent-storm';
import {type AnyDuration, convertDuration} from 'date-vir';
import {monorepoRoot} from './file-paths.js';
import {type launcherSwitchRequestShape, type ReleaseBuild, releaseBuild} from './release-build.js';
import {loadSettings} from './settings.js';

/**
 * Branch the local checkout is compared against. Hardcoded to `dev` per project convention — that
 * is the default branch in `electrovir/agent-storm` and the one the user pulls from to update.
 */
const upstreamBranch = 'dev';

/**
 * Cache window for the remote lookups (the upstream SHA, the latest release). Each costs a network
 * round-trip per call, so a TTL of minutes keeps polling traffic flat while still letting the
 * banner clear within minutes of a fresh push landing on `dev`. Negative results (network down,
 * branch missing) honor the same TTL so a sustained outage doesn't have us re-running the lookup
 * every sidebar poll.
 */
const remoteLookupCacheTtl: AnyDuration = {
    minutes: 10,
};

const fullShaPattern = /^[0-9a-f]{40}$/i;

/** Wraps `lookup` so its result, `undefined` included, is reused for {@link remoteLookupCacheTtl}. */
function createCachedLookup<T>(lookup: () => Promise<T | undefined>) {
    const cache: {
        value: T | undefined;
        fetchedAt: number;
        inFlight: Promise<T | undefined> | undefined;
    } = {
        value: undefined,
        fetchedAt: 0,
        inFlight: undefined,
    };
    return async function getCachedValue(): Promise<T | undefined> {
        if (
            cache.fetchedAt > 0 &&
            Date.now() - cache.fetchedAt <
                convertDuration(remoteLookupCacheTtl, {
                    milliseconds: true,
                }).milliseconds
        ) {
            return cache.value;
        } else if (cache.inFlight) {
            return cache.inFlight;
        }
        cache.inFlight = lookup()
            .then((value) => {
                cache.value = value;
                cache.fetchedAt = Date.now();
                return value;
            })
            .finally(() => {
                cache.inFlight = undefined;
            });
        return cache.inFlight;
    };
}

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

const getRemoteSha = createCachedLookup(fetchRemoteSha);

const getLatestReleaseVersion = createCachedLookup(async () => {
    try {
        return await fetchLatestVersion();
    } catch {
        return undefined;
    }
});

/**
 * Sentinel returned whenever the backend can't (or has been told not to) determine update status.
 * The sidebar treats `isUpToDate: null` as "no banner" — only `isUpToDate === false` triggers it.
 */
const unknownUpdateStatus: UpdateStatus = {
    isUpToDate: null,
    currentVersion: null,
    latestVersion: null,
    canInstall: false,
    failedVersion: null,
};

const updateInstallState: {
    inFlight: Promise<void> | undefined;
    failedVersion: string | undefined;
} = {
    inFlight: undefined,
    failedVersion: undefined,
};

/** Only a release started by the launcher has the IPC channel the switch request goes over. */
function canSwitchVersions() {
    return !!releaseBuild && process.send != undefined;
}

async function getCheckoutUpdateStatus(): Promise<UpdateStatus> {
    const [
        currentSha,
        remoteSha,
    ] = await Promise.all([
        getCurrentSha(),
        getRemoteSha(),
    ]);
    if (!currentSha || !remoteSha) {
        return {
            ...unknownUpdateStatus,
            currentVersion: currentSha || null,
            latestVersion: remoteSha || null,
        };
    }
    return {
        ...unknownUpdateStatus,
        /**
         * Ancestor check instead of plain equality so a local branch that has merged + committed
         * past the remote tip ("ahead") still reads as up-to-date and the banner stays hidden.
         */
        isUpToDate: await isRemoteShaAncestorOfHead(remoteSha),
        currentVersion: currentSha,
        latestVersion: remoteSha,
    };
}

async function getReleaseUpdateStatus(release: Readonly<ReleaseBuild>): Promise<UpdateStatus> {
    const [
        latestVersion,
        activeVersions,
    ] = await Promise.all([
        getLatestReleaseVersion(),
        readActiveVersions(versionsDir).catch(() => undefined),
    ]);
    const status: UpdateStatus = {
        ...unknownUpdateStatus,
        currentVersion: release.version,
        latestVersion: latestVersion || null,
        canInstall: canSwitchVersions(),
        failedVersion: updateInstallState.failedVersion || activeVersions?.rejected || null,
    };
    /** A release built from an untagged commit has no version to compare. */
    if (!latestVersion || !isReleaseVersion(release.version)) {
        return status;
    }
    return {
        ...status,
        isUpToDate: !isNewerVersion({
            version: latestVersion,
            than: release.version,
        }),
    };
}

export async function getUpdateStatus(): Promise<UpdateStatus> {
    const settings = await loadSettings().catch(() => undefined);
    if (settings?.disableUpdateCheck) {
        return unknownUpdateStatus;
    }
    return releaseBuild
        ? await getReleaseUpdateStatus(releaseBuild)
        : await getCheckoutUpdateStatus();
}

/**
 * Installs the latest release in the background, then asks the launcher to switch to it. Does
 * nothing while an install is already running.
 */
export async function startUpdateInstall() {
    const version = await getLatestReleaseVersion();
    if (!version || !canSwitchVersions()) {
        throw new Error('This agent-storm cannot install updates itself.');
    }
    updateInstallState.inFlight ??= installRelease({
        versionsDir,
        version,
    })
        .then(() => {
            process.send?.({
                switchTo: version,
            } satisfies typeof launcherSwitchRequestShape.runtimeType);
        })
        .catch((error: unknown) => {
            updateInstallState.failedVersion = version;
            log.error(`Failed to install agent-storm ${version}: ${extractErrorMessage(error)}`);
        })
        .finally(() => {
            updateInstallState.inFlight = undefined;
        });
}
