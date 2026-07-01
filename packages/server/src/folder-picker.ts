import {execFile} from 'node:child_process';
import {homedir} from 'node:os';

/**
 * Opens a native OS folder-picker dialog on the machine running the server. Returns the absolute
 * path the user selected, or `null` if they cancelled.
 *
 * macOS: uses `osascript` (always present on macOS).
 * Linux: tries `zenity`, then `kdialog` — whichever the user has installed.
 */
export async function pickFolder(): Promise<string | null> {
    if (process.platform === 'darwin') {
        return await pickFolderMac();
    }
    return await pickFolderLinux();
}

async function pickFolderMac(): Promise<string | null> {
    const script = `try
    set chosen to choose folder with prompt "Select repo folder"
    return POSIX path of chosen
on error number -128
    return ""
end try`;

    const result = await runDialog('osascript', [
        '-e',
        script,
    ]);
    if (result.status === 'missing') {
        throw new Error('`osascript` not found — required for the folder picker on macOS.');
    }
    if (result.status === 'error') {
        throw new Error(`Folder picker failed: ${result.message}`);
    }
    return result.path;
}

async function pickFolderLinux(): Promise<string | null> {
    const home = homedir();
    const tools = [
        {
            cmd: 'zenity',
            args: [
                '--file-selection',
                '--directory',
                '--title=Select repo folder',
                `--filename=${home}/`,
            ],
        },
        {
            cmd: 'kdialog',
            args: [
                '--getexistingdirectory',
                home,
                '--title',
                'Select repo folder',
            ],
        },
    ];

    const errors: string[] = [];
    for (const {cmd, args} of tools) {
        const result = await runDialog(cmd, args);
        if (result.status === 'missing') {
            continue;
        }
        if (result.status === 'error') {
            errors.push(`${cmd}: ${result.message}`);
            continue;
        }
        return result.path;
    }

    if (errors.length === 0) {
        throw new Error(
            'No native folder picker found. Install `zenity` (GNOME/Cinnamon) or `kdialog` (KDE) to enable folder selection.',
        );
    }
    throw new Error(`Folder picker failed: ${errors.join('; ')}`);
}

type DialogResult =
    | {status: 'ok'; path: string | null}
    | {status: 'missing'}
    | {status: 'error'; message: string};

/**
 * Runs a folder-picker binary and classifies the outcome.
 *
 * - `ok` + path: user selected a folder
 * - `ok` + null: user cancelled cleanly (binary exited with empty stdout)
 * - `missing`: binary not installed (spawn ENOENT)
 * - `error`: binary failed for some other reason — stderr is included so the caller can surface it
 *
 * GUI pickers like `zenity` and `kdialog` exit non-zero on user cancellation, so a non-zero exit
 * code alone is not enough to know something is wrong. We treat non-zero+empty-stderr as cancel,
 * and anything that wrote to stderr as a real error.
 */
function runDialog(cmd: string, args: ReadonlyArray<string>): Promise<DialogResult> {
    return new Promise((resolvePromise) => {
        execFile(cmd, [...args], (error, stdout, stderr) => {
            if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
                resolvePromise({status: 'missing'});
                return;
            }
            const trimmedErr = stderr.trim();
            if (error && trimmedErr) {
                resolvePromise({status: 'error', message: trimmedErr});
                return;
            }
            const path = stdout.trim();
            resolvePromise({
                status: 'ok',
                path: path ? stripTrailingSlash(path) : null,
            });
        });
    });
}

function stripTrailingSlash(path: string): string {
    return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
}
