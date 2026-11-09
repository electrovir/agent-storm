// cspell:words argv frontmost osascript

import {type MaybePromise} from '@augment-vir/common';
import {currentOperatingSystem, OperatingSystem} from '@augment-vir/node';
import {runCommand} from 'agent-storm';
import {homedir} from 'node:os';
import {relative} from 'node:path';

/**
 * Finds the window by the folder path in its title, which VS Code's default `window.title` leaves
 * out: it only matches with `${folderPath}` added to that setting. VS Code's windows expose no
 * close button to accessibility, so the window is raised and closed through its own File menu
 * instead, and the front-window check stops a raise that didn't take from closing some other
 * window.
 */
const closeVsCodeWindowScript = [
    'on run argv',
    '    set folderPath to item 1 of argv',
    '    tell application "System Events"',
    '        set previousApp to first application process whose frontmost is true',
    '        tell process "Code"',
    '            set matches to (every window whose name contains (" — " & folderPath & " — ") or name ends with (" — " & folderPath))',
    '            if (count of matches) is not 1 then return',
    '            set target to item 1 of matches',
    '            set targetName to name of target',
    '            set frontmost to true',
    '            perform action "AXRaise" of target',
    '            delay 0.3',
    '            if name of window 1 is not targetName then',
    '                set frontmost of previousApp to true',
    '                return',
    '            end if',
    '            click menu item "Close Window" of menu "File" of menu bar 1',
    '        end tell',
    '        set frontmost of previousApp to true',
    '    end tell',
    'end run',
].join('\n');

const editorWindowClosers: Record<
    OperatingSystem,
    undefined | ((params: Readonly<{folder: string}>) => MaybePromise<void>)
> = {
    async [OperatingSystem.Mac]({folder}) {
        await runCommand(
            'osascript',
            [
                '-e',
                closeVsCodeWindowScript,
                [
                    '~',
                    relative(homedir(), folder),
                ].join('/'),
            ],
            {
                timeout: {
                    seconds: 30,
                },
            },
        );
    },
    [OperatingSystem.Linux]: undefined,
    [OperatingSystem.Windows]: undefined,
};

/**
 * Closes the VS Code window open on a folder inside the home directory, and does nothing when no
 * window is. Undefined on operating systems that have no implementation yet.
 */
export const closeEditorWindow = editorWindowClosers[currentOperatingSystem];
