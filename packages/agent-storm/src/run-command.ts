import {convertDuration, type AnyDuration} from 'date-vir';
import {execFile, type ExecFileOptions} from 'node:child_process';
import {promisify} from 'node:util';

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
    const pending = execFileAsync(command, [...args], {
        ...options,
        encoding: 'utf8',
        timeout: convertDuration(timeout, {
            milliseconds: true,
        }).milliseconds,
    });
    if (stdin != undefined) {
        pending.child.stdin?.end(stdin);
    }
    return await pending;
}
