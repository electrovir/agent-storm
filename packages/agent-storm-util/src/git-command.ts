import {check} from '@augment-vir/assert';
import {convertByteSize, extractErrorMessage, type AnyByteSize} from '@augment-vir/common';
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
 * Runs the GitHub CLI. Never throws: a failed or timed-out call answers with its exit code and
 * stderr instead.
 *
 * @category Util
 */
export async function runGh(args: ReadonlyArray<string>): Promise<GhExecResult> {
    try {
        const result = await runCommand('gh', [...args], {
            maxBuffer: convertByteSize(ghMaxBuffer, {
                bytes: true,
            }).bytes,
            timeout: ghTimeout,
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
