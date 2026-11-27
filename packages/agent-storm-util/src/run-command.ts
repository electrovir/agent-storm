import {convertDuration, type AnyDuration} from 'date-vir';
import {execFile, type ExecFileOptions} from 'node:child_process';
import {basename} from 'node:path';
import {promisify} from 'node:util';
import {tracePerfSpan} from './perf-trace.js';

const execFileAsync = promisify(execFile);

/**
 * `execFile` from `node:child_process`, resolving with `{stdout, stderr}` and rejecting on a
 * nonzero exit. Unlike `execFile`, a deadline is required: past `timeout` the child is killed and
 * the call rejects, so a hung `git` or `gh` (a network stall, a credential prompt) can't wait
 * forever.
 *
 * @category Util
 */
export async function runCommand(
    command: string,
    args: ReadonlyArray<string>,
    {
        timeout,
        stdin,
        ...options
    }: Readonly<
        Omit<ExecFileOptions, 'timeout' | 'encoding'> & {
            timeout: AnyDuration;
            /** Written to the child's stdin, which is then closed. */
            stdin?: string | undefined;
        }
    >,
) {
    /** Only plain words like `worktree add`, so paths, refs, and long queries stay out of names. */
    const subcommand = args
        .filter((arg) => /^[a-z][a-z-]*$/.test(arg))
        .slice(0, 2)
        .join(' ');
    return await tracePerfSpan(`${basename(command)} ${subcommand}`.trim(), async () => {
        return await runCommandUntraced({
            command,
            args,
            timeout,
            stdin,
            options,
        });
    });
}

async function runCommandUntraced({
    command,
    args,
    timeout,
    stdin,
    options,
}: Readonly<{
    command: string;
    args: ReadonlyArray<string>;
    timeout: AnyDuration;
    stdin: string | undefined;
    options: Omit<ExecFileOptions, 'timeout' | 'encoding'>;
}>) {
    const timeoutMilliseconds = convertDuration(timeout, {
        milliseconds: true,
    }).milliseconds;
    const pending = execFileAsync(command, [...args], {
        ...options,
        encoding: 'utf8',
        timeout: timeoutMilliseconds,
    });
    if (stdin != undefined) {
        pending.child.stdin?.end(stdin);
    }
    /**
     * `execFile` only settles once the killed child exits. A child that ignores the kill, or one
     * macOS leaves stuck mid-exit (`E` in `ps`), never does, and that held the folder sweep for
     * good.
     */
    const deadline = Promise.withResolvers<never>();
    const deadlineTimer = setTimeout(
        () => {
            deadline.reject(
                new Error(`'${command}' did not exit after being killed at its timeout.`),
            );
        },
        timeoutMilliseconds +
            convertDuration(
                {
                    seconds: 1,
                },
                {
                    milliseconds: true,
                },
            ).milliseconds,
    );
    try {
        return await Promise.race([
            pending,
            deadline.promise,
        ]);
    } finally {
        clearTimeout(deadlineTimer);
    }
}
