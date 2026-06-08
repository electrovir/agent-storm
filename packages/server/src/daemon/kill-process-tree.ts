import {filterMap, groupArrayBy} from '@augment-vir/common';
import {execFileSync} from 'node:child_process';

type ProcessRow = {
    pid: number;
    ppid: number;
};

/**
 * Parse the output of `ps -A -o pid=,ppid=` into `{pid, ppid}` rows, dropping any line that doesn't
 * hold two integers (blank lines, headers, partial reads).
 */
export function parseProcessTable(processTable: string): ProcessRow[] {
    return filterMap(
        processTable.split('\n'),
        (rawLine) => {
            const [
                pid,
                ppid,
            ] = rawLine.trim().split(/\s+/).map(Number);
            return {
                pid,
                ppid,
            };
        },
        (row): row is ProcessRow => Number.isInteger(row.pid) && Number.isInteger(row.ppid),
    );
}

/**
 * Walk a process table to collect every descendant pid of `rootPid`, depth-first and excluding the
 * root itself. Used to tear down a pane's whole subtree: an interactive shell (`zsh -i`) enables
 * job control and runs the AI command (e.g. `codex`) in its own process group, so neither
 * `pty.kill()` (shell pid only) nor a single process-group signal reaches it — we have to find each
 * descendant by pid.
 */
export function collectDescendantPids(processTable: string, rootPid: number): number[] {
    const childrenByParent = groupArrayBy(parseProcessTable(processTable), (row) => row.ppid);

    function walk(parentPid: number): number[] {
        return (childrenByParent[parentPid] ?? []).flatMap((row) => [
            row.pid,
            ...walk(row.pid),
        ]);
    }

    return walk(rootPid);
}

/** Absolute path so PATH lookup can't be hijacked (and to satisfy sonarjs/no-os-command-from-path). */
const psBinaryPath = '/bin/ps';

function snapshotProcessTable(): string {
    try {
        return execFileSync(psBinaryPath, [
            '-A',
            '-o',
            'pid=,ppid=',
        ]).toString('utf-8');
    } catch {
        return '';
    }
}

function signalPid(pid: number, signal: NodeJS.Signals): void {
    try {
        process.kill(pid, signal);
    } catch {
        /* the process is already gone */
    }
}

/**
 * Kill a process and every process it spawned. node-pty starts a pane's shell as a session leader,
 * but the AI command runs in its own job-control process group, so signalling only the shell leaves
 * the AI process orphaned — and a TUI agent reading its now-dead controlling terminal busy-loops at
 * 100% CPU forever (reparented to launchd). We snapshot the full process table once, then signal
 * every descendant by pid so they're still reachable after the shell dies and they reparent.
 *
 * A graceful SIGHUP goes out first; a SIGKILL backstop follows for anything that ignored it. Pass
 * `immediate` on daemon shutdown, where the event loop is about to stop and a deferred SIGKILL
 * would never fire.
 */
export function killProcessTree(
    rootPid: number,
    {immediate = false}: Readonly<{immediate?: boolean | undefined}> = {},
): void {
    const pids = [
        rootPid,
        ...collectDescendantPids(snapshotProcessTable(), rootPid),
    ];
    pids.forEach((pid) => signalPid(pid, 'SIGHUP'));
    if (immediate) {
        pids.forEach((pid) => signalPid(pid, 'SIGKILL'));
    } else {
        setTimeout(() => pids.forEach((pid) => signalPid(pid, 'SIGKILL')), 250);
    }
}
