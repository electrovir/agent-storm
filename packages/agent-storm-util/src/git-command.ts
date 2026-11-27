import {check} from '@augment-vir/assert';
import {
    convertByteSize,
    extractErrorMessage,
    type AnyByteSize,
    type MaybePromise,
} from '@augment-vir/common';
import {type AnyDuration} from 'date-vir';
import {runCommand} from './run-command.js';

/**
 * Environment for git calls that only read. `git status` otherwise takes `index.lock` to save the
 * stat info it refreshed, and while it holds it every write to the index in that checkout fails,
 * including the user staging a file and an agent committing. Required locks are unaffected.
 *
 * @category Util
 */
export const readOnlyGitEnv = {
    ...process.env,
    GIT_OPTIONAL_LOCKS: '0',
};

/**
 * Deadline for a git call that isn't expected to take long, including a `fetch`. Generous, because
 * it only exists so a network stall or a credential prompt can't hold a caller forever.
 *
 * @category Util
 */
export const gitTimeout: AnyDuration = {
    minutes: 2,
};

/**
 * Rate-limit detection on `gh`'s stderr.
 *
 * GitHub itself authoritatively signals rate limits three ways.
 *
 * 1. HTTP `429 Too Many Requests`.
 * 2. HTTP `403 Forbidden` with `x-ratelimit-remaining: 0` (primary rate limit hit).
 * 3. A GraphQL error body with `type: "RATE_LIMIT"` or `code: "graphql_rate_limit"` (secondary /
 *    GraphQL-specific limits).
 *
 * `gh` only surfaces the HTTP status line and the API's `message` field on stderr — never the
 * response headers — so the `x-ratelimit-remaining: 0` signal isn't visible to us. We instead match
 * on what `gh` actually prints: the literal `HTTP 429` / `HTTP 403` status, the API's "API rate
 * limit exceeded" message, secondary-limit phrasing, and the GraphQL `RATE_LIMIT` error type that
 * bleeds through when the error gets printed verbatim.
 *
 * @category Util
 */
export function looksRateLimited(stderr: string): boolean {
    return (
        /rate[\s_-]?limit/i.test(stderr) ||
        /HTTP\s+429\b/i.test(stderr) ||
        /\bRATE_LIMIT(?:ED)?\b/.test(stderr) ||
        /graphql_rate_limit/i.test(stderr)
    );
}

/**
 * The stderr of a failed `runCommand`, or the error's message when there's none (git missing, a
 * timeout).
 *
 * @category Util
 */
export function extractCommandStderr(error: unknown) {
    return (
        (check.isObject(error) && check.hasKey(error, 'stderr')
            ? String(error.stderr).trim()
            : '') || extractErrorMessage(error)
    );
}

/**
 * Runs a read-only git command in `cwd`. Its stdout, or undefined when git fails for any reason.
 *
 * @category Util
 */
export async function tryGit(cwd: string, args: ReadonlyArray<string>) {
    const result = await runCommand('git', [...args], {
        cwd,
        env: readOnlyGitEnv,
        timeout: gitTimeout,
    }).catch(() => undefined);
    return result?.stdout;
}

/**
 * What one `gh` call printed and how it exited.
 *
 * @category Internal
 */
export type GhExecResult = {
    exitCode: number;
    stdout: string;
    stderr: string;
};

/**
 * Deadline for one `gh` call. A timed-out call fails like any other.
 *
 * @category Internal
 */
export const ghTimeout: AnyDuration = {
    minutes: 1,
};

/**
 * Node's 1 MB default cuts off big GraphQL answers, such as a PR with many long review threads,
 * which then fail as unparsable JSON.
 */
const ghMaxBuffer: AnyByteSize = {
    megabytes: 50,
};

/**
 * What one HTTP request inside a `gh` call drew from GitHub's rate limits, read from the response's
 * `X-Ratelimit-*` headers.
 *
 * @category Internal
 */
export type GhRequestCost = {
    /** The budget the request drew from, such as `graphql`, `core`, or `search`. */
    resource: string;
    used: number;
    remaining: number;
    /** Unix seconds when the budget resets. */
    resetAt: number;
    /**
     * How far `used` rose since the previous logged request on the same budget and reset time.
     * GitHub doesn't report a request's own cost, so this also counts concurrent calls and `gh`
     * calls made outside agent-storm. GitHub answers from more than one counter at once, each with
     * its own reset time, so `undefined` for the first request seen on a counter.
     */
    cost: number | undefined;
};

/**
 * One `gh` call, for {@link GhCallLogger}.
 *
 * @category Internal
 */
export type GhCallLog = {
    args: string[];
    cwd: string | undefined;
    exitCode: number;
    durationMs: number;
    requests: GhRequestCost[];
};

/**
 * Receives every `gh` call while `isEnabled` resolves true. Those calls run with `GH_DEBUG=api`, so
 * leave it disabled when not in use.
 *
 * @category Internal
 */
export type GhCallLogger = {
    /** Checked before every `gh` call. A rejection counts as disabled. */
    isEnabled: () => MaybePromise<boolean>;
    /** Called after each logged `gh` call finishes. A rejection is ignored. */
    log: (call: GhCallLog) => MaybePromise<void>;
};

type GhCallLogging = {
    logger: GhCallLogger | undefined;
    /** `used` per budget and reset time. */
    lastUsed: Partial<Record<string, number>>;
};

/** On `globalThis` because each plugin's server bundle carries its own copy of this module. */
function getGhCallLogging(): GhCallLogging {
    const key = Symbol.for('agent-storm.gh-call-logging');
    const existing: unknown = Reflect.get(globalThis, key);
    if (existing) {
        return existing as GhCallLogging;
    }
    const created: GhCallLogging = {
        logger: undefined,
        lastUsed: {},
    };
    Reflect.set(globalThis, key, created);
    return created;
}

/**
 * Sets the logger every `gh` call in this process reports to, including calls from plugin bundles.
 * `undefined` stops logging.
 *
 * @category Util
 */
export function setGhCallLogger(logger: GhCallLogger | undefined) {
    getGhCallLogging().logger = logger;
}

/**
 * Splits `gh`'s stderr under `GH_DEBUG=api` into the rate-limit headers of each response and the
 * stderr `gh` would have printed without it.
 *
 * @category Internal
 */
export function parseGhDebugOutput(stderr: string) {
    /**
     * Mutated in place: `GH_DEBUG=api` prints every response body, tens of thousands of lines for a
     * big query, and copying the arrays per line made this quadratic and block the event loop for
     * seconds.
     */
    const parsed: {
        stderrLines: string[];
        /** Lines of the request being read, kept in case its closing line never comes. */
        openRequest: string[] | undefined;
        requests: Record<string, string>[];
    } = {
        stderrLines: [],
        openRequest: undefined,
        requests: [],
    };
    stderr.split('\n').forEach((line) => {
        if (line.startsWith('* Request at ')) {
            parsed.openRequest = [
                line,
            ];
        } else if (parsed.openRequest && line.startsWith('* Request took ')) {
            const headers = readHeaderLines(parsed.openRequest);
            parsed.openRequest = undefined;
            if (headers['x-ratelimit-resource']) {
                parsed.requests.push(headers);
            }
        } else if (parsed.openRequest) {
            parsed.openRequest.push(line);
        } else if (!/^\[git .*\]$/.test(line)) {
            /** `GH_DEBUG` also echoes each git command `gh` runs. */
            parsed.stderrLines.push(line);
        }
    });
    return {
        stderr: [
            ...parsed.stderrLines,
            ...(parsed.openRequest || []).filter((line) => !/^[*<>] /.test(line)),
        ]
            .join('\n')
            .trim(),
        rateLimits: parsed.requests.map((headers) => {
            return {
                resource: headers['x-ratelimit-resource'] || '',
                used: Number(headers['x-ratelimit-used']),
                remaining: Number(headers['x-ratelimit-remaining']),
                resetAt: Number(headers['x-ratelimit-reset']),
            };
        }),
    };
}

function readHeaderLines(lines: ReadonlyArray<string>) {
    return lines.reduce<Record<string, string>>((headers, line) => {
        const match = /^< ([\w-]+): (.*)$/.exec(line);
        return match?.[1] && match[2] != undefined
            ? {
                  ...headers,
                  [match[1].toLowerCase()]: match[2].trim(),
              }
            : headers;
    }, {});
}

async function logGhCall({
    logger,
    args,
    cwd,
    exitCode,
    startedAt,
    stderr,
}: Readonly<{
    logger: GhCallLogger;
    args: ReadonlyArray<string>;
    cwd: string | undefined;
    exitCode: number;
    startedAt: number;
    stderr: string;
}>) {
    const logging = getGhCallLogging();
    const parsed = parseGhDebugOutput(stderr);
    const requests = parsed.rateLimits.map((rateLimit): GhRequestCost => {
        const counterKey = `${rateLimit.resource} ${rateLimit.resetAt}`;
        const previousUsed = logging.lastUsed[counterKey];
        logging.lastUsed[counterKey] = rateLimit.used;
        return {
            ...rateLimit,
            cost: previousUsed == undefined ? undefined : rateLimit.used - previousUsed,
        };
    });
    try {
        await logger.log({
            args: [...args],
            cwd,
            exitCode,
            durationMs: Date.now() - startedAt,
            requests,
        });
    } catch {
        /* a failed log write must not fail the `gh` call */
    }
    return parsed.stderr;
}

/**
 * Runs the GitHub CLI in `cwd`, rejecting like {@link runCommand} on a nonzero exit. Reports the
 * call to the {@link setGhCallLogger} logger while it's enabled.
 *
 * @category Util
 */
export async function runGhCommand({
    args,
    cwd,
}: Readonly<{
    args: ReadonlyArray<string>;
    cwd?: string | undefined;
}>) {
    const commandOptions = {
        cwd,
        maxBuffer: convertByteSize(ghMaxBuffer, {
            bytes: true,
        }).bytes,
        timeout: ghTimeout,
    };
    const logger = getGhCallLogging().logger;
    const isLogging = logger ? await Promise.resolve(logger.isEnabled()).catch(() => false) : false;
    if (!logger || !isLogging) {
        return await runCommand('gh', [...args], commandOptions);
    }
    const startedAt = Date.now();
    try {
        const result = await runCommand('gh', [...args], {
            ...commandOptions,
            env: {
                ...process.env,
                GH_DEBUG: 'api',
            },
        });
        return {
            stdout: result.stdout,
            stderr: await logGhCall({
                logger,
                args,
                cwd,
                exitCode: 0,
                startedAt,
                stderr: result.stderr,
            }),
        };
    } catch (error) {
        const exitCode =
            check.isObject(error) && check.hasKey(error, 'code') && check.isNumber(error.code)
                ? error.code
                : 1;
        const stderr = await logGhCall({
            logger,
            args,
            cwd,
            exitCode,
            startedAt,
            stderr:
                check.isObject(error) && check.hasKey(error, 'stderr') ? String(error.stderr) : '',
        });
        throw Object.assign(new Error(stderr || extractErrorMessage(error)), {
            code: exitCode,
            stdout:
                check.isObject(error) && check.hasKey(error, 'stdout') ? String(error.stdout) : '',
            stderr,
        });
    }
}

/**
 * Runs the GitHub CLI. Never throws: a failed or timed-out call answers with its exit code and
 * stderr instead.
 *
 * @category Util
 */
export async function runGh(args: ReadonlyArray<string>): Promise<GhExecResult> {
    try {
        const result = await runGhCommand({
            args,
        });
        return {
            exitCode: 0,
            stdout: result.stdout,
            stderr: result.stderr,
        };
    } catch (error) {
        return {
            exitCode:
                check.isObject(error) && check.hasKey(error, 'code') && check.isNumber(error.code)
                    ? error.code
                    : 1,
            stdout:
                check.isObject(error) && check.hasKey(error, 'stdout') ? String(error.stdout) : '',
            stderr: extractCommandStderr(error),
        };
    }
}

/**
 * The most requests a GitHub GraphQL query can make and still cost 1 point. GitHub charges a query
 * its requests divided by 100 and rounded, at least 1 point, where each list in the query counts
 * once for every node of the list it sits in.
 */
const maxRequestsPerPoint = 149;

/**
 * Groups the parts of a GraphQL query so each group fits in one 1-point query. Sent one part per
 * query, every part costs a point however small it is. A part too big to fit gets a group of its
 * own.
 *
 * @category Util
 */
export function packGraphqlParts<Part>({
    parts,
    countRequests,
}: Readonly<{
    parts: ReadonlyArray<Part>;
    countRequests: (part: Part) => number;
}>) {
    return parts
        .toSorted((first, second) => countRequests(second) - countRequests(first))
        .reduce<Part[][]>((groups, part) => {
            const groupIndex = groups.findIndex((group) => {
                return (
                    group.reduce((total, member) => total + countRequests(member), 0) +
                        countRequests(part) <=
                    maxRequestsPerPoint
                );
            });
            return groupIndex < 0
                ? [
                      ...groups,
                      [
                          part,
                      ],
                  ]
                : groups.map((group, index) => {
                      return index === groupIndex
                          ? [
                                ...group,
                                part,
                            ]
                          : group;
                  });
        }, []);
}
