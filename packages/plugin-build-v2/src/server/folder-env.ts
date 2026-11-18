import {convertByteSize, extractErrorMessage, log} from '@augment-vir/common';
import {runCommand} from 'agent-storm-util';

const envMarker = '\0agent-storm-folder-env\0';

/**
 * The environment a terminal opened in `cwd` would have: the user's login shell runs there the way
 * the AI Session panes start theirs, so per-folder setup such as a direnv `.envrc` applies.
 * Undefined when that shell can't be read, so the caller falls back to the server's own
 * environment.
 */
export async function readFolderEnv(cwd: string) {
    const shell = process.env.SHELL;
    if (!shell || process.platform === 'win32') {
        return undefined;
    }
    try {
        const {stdout} = await runCommand(
            shell,
            [
                '-lic',
                `printf '${envMarker.replaceAll('\0', '\\0')}'; env -0`,
            ],
            {
                cwd,
                timeout: {
                    seconds: 15,
                },
                maxBuffer: convertByteSize(
                    {
                        megabytes: 10,
                    },
                    {
                        bytes: true,
                    },
                ).bytes,
            },
        );
        return parseFolderEnv(stdout);
    } catch (error) {
        log.warning(
            `Reading the shell environment in ${cwd} failed: ${extractErrorMessage(error)}`,
        );
        return undefined;
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
