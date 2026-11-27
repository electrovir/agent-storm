import {extractErrorMessage, log, wrapInTry} from '@augment-vir/common';
import {tracePerfSpan} from 'agent-storm-util';
import {convertDuration} from 'date-vir';
import {spawn} from 'node:child_process';
import {mkdtemp, open, rm, type FileHandle} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const envMarker = '\0agent-storm-folder-env\0';

/**
 * Each folder's last read environment, and the read in flight for it. Mutated in place: these are
 * caches that live as long as the server.
 */
const folderEnvCache = {
    latest: new Map<string, Record<string, string>>(),
    inFlight: new Map<string, Promise<Record<string, string> | undefined>>(),
};

/**
 * The environment a terminal opened in `cwd` would have: the user's login shell runs there the way
 * the AI Session panes start theirs, so per-folder setup such as a direnv `.envrc` applies.
 * Undefined when that shell can't be read, so the caller falls back to the server's own
 * environment.
 *
 * Starting a login shell takes seconds, so once a folder's environment has been read, this answers
 * with that copy right away and reads it again in the background for next time. A change to the
 * folder's setup reaches the call after the one that reads it.
 */
export async function readFolderEnv(cwd: string) {
    const inFlight =
        folderEnvCache.inFlight.get(cwd) ||
        readShellEnv(cwd).then((env) => {
            folderEnvCache.inFlight.delete(cwd);
            if (env) {
                folderEnvCache.latest.set(cwd, env);
            }
            return env;
        });
    folderEnvCache.inFlight.set(cwd, inFlight);
    return folderEnvCache.latest.get(cwd) || (await inFlight);
}

/**
 * Mutated in place: counts the login shells reading an environment and holds the reads waiting for
 * one of them to finish.
 */
const shellReads: {
    runningCount: number;
    waiting: Array<() => void>;
} = {
    runningCount: 0,
    waiting: [],
};

/**
 * A login shell forks many short-lived processes of its own (nvm, oh-my-zsh, direnv), and a server
 * restart resumes every live thread at once, each in its own folder. Started all together, those
 * shells hit macOS's per-user process limit, and then nothing on the machine can start a process.
 */
const maxConcurrentShellReads = 4;

async function withShellReadSlot<T>(run: () => Promise<T>) {
    if (shellReads.runningCount < maxConcurrentShellReads) {
        shellReads.runningCount++;
    } else {
        await new Promise<void>((resolve) => {
            shellReads.waiting.push(resolve);
        });
    }
    try {
        return await run();
    } finally {
        /** A finished read hands its slot straight to the next waiting read. */
        const next = shellReads.waiting.shift();
        if (next) {
            next();
        } else {
            shellReads.runningCount--;
        }
    }
}

async function readShellEnv(cwd: string) {
    const shell = process.env.SHELL;
    if (!shell || process.platform === 'win32') {
        return undefined;
    }
    try {
        return await withShellReadSlot(async () => {
            return await tracePerfSpan('read folder env', async () => {
                const output = await openUnlinkedFile();
                try {
                    await runLoginShell({
                        shell,
                        cwd,
                        output,
                    });
                    const {size} = await output.stat();
                    const {buffer} = await output.read(Buffer.alloc(size), 0, size, 0);
                    return parseFolderEnv(buffer.toString('utf8'));
                } finally {
                    await output.close();
                }
            });
        });
    } catch (error) {
        log.warning(
            `Reading the shell environment in ${cwd} failed: ${extractErrorMessage(error)}`,
        );
        return undefined;
    }
}

/** A temp file already removed from disk, so nothing is left behind if the server stops. */
async function openUnlinkedFile() {
    const dir = await mkdtemp(join(tmpdir(), 'agent-storm-folder-env-'));
    try {
        return await open(join(dir, 'env'), 'w+');
    } finally {
        await rm(dir, {
            recursive: true,
            force: true,
        });
    }
}

/**
 * The shell writes to a file rather than a pipe back to this server. A server restart closes the
 * pipe while the shell is still starting, and zsh then hangs for good in its exit handler instead
 * of exiting.
 */
async function runLoginShell({
    shell,
    cwd,
    output,
}: Readonly<{
    shell: string;
    cwd: string;
    output: FileHandle;
}>) {
    const child = spawn(
        shell,
        [
            '-lic',
            `printf '${envMarker.replaceAll('\0', '\\0')}'; env -0`,
        ],
        {
            cwd,
            /** Its own process group, so a timeout also kills what its startup files started. */
            detached: true,
            stdio: [
                'ignore',
                output.fd,
                output.fd,
            ],
        },
    );
    const exited = Promise.withResolvers<void>();
    child.once('error', exited.reject);
    child.once('exit', () => exited.resolve());
    const timer = setTimeout(
        () => {
            wrapInTry(
                () => {
                    process.kill(-(child.pid ?? 0), 'SIGKILL');
                },
                {
                    fallbackValue: undefined,
                },
            );
            exited.reject(new Error('The shell did not finish starting in time.'));
        },
        convertDuration(
            {
                seconds: 15,
            },
            {
                milliseconds: true,
            },
        ).milliseconds,
    );
    try {
        await exited.promise;
    } finally {
        clearTimeout(timer);
    }
}

/** Reads the `env -0` output `readFolderEnv`'s shell prints after its marker. */
export function parseFolderEnv(stdout: string) {
    /** Shell startup files can print anything before the environment, such as a screen clear. */
    const markerIndex = stdout.lastIndexOf(envMarker);
    if (markerIndex < 0) {
        throw new Error('The shell printed no environment.');
    }
    return stdout
        .slice(markerIndex + envMarker.length)
        .split('\0')
        .reduce<Record<string, string>>((env, entry) => {
            const separatorIndex = entry.indexOf('=');
            return separatorIndex > 0
                ? {
                      ...env,
                      [entry.slice(0, separatorIndex)]: entry.slice(separatorIndex + 1),
                  }
                : env;
        }, {});
}
