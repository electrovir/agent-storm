// cspell:words apos systemctl systemd

import {assertWrap} from '@augment-vir/assert';
import {getObjectTypedEntries, type PartialWithUndefined} from '@augment-vir/common';
import {currentOperatingSystem, OperatingSystem} from '@augment-vir/node';
import {execFile} from 'node:child_process';
import {access, mkdir, rm, writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {dirname, resolve} from 'node:path';
import {promisify} from 'node:util';

const execFileAsync = promisify(execFile);

const loginItemLabel = 'com.github.electrovir.agent-storm';

export type LoginItemParams = {
    nodePath: string;
    launcherPath: string;
    logPath: string;
    /** A login item doesn't get the user's shell environment, so it carries what the app needs. */
    env: Readonly<Record<string, string>>;
};

function escapeXml(value: string) {
    return value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&apos;');
}

/**
 * The LaunchAgent that runs the launcher. launchd restarts the launcher when it crashes but not
 * when it exits cleanly, which is how quitting on purpose works.
 */
export function buildLaunchAgentPlist({
    nodePath,
    launcherPath,
    logPath,
    env,
}: Readonly<LoginItemParams>) {
    return [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
        '<plist version="1.0">',
        '<dict>',
        '    <key>Label</key>',
        `    <string>${loginItemLabel}</string>`,
        '    <key>ProgramArguments</key>',
        '    <array>',
        `        <string>${escapeXml(nodePath)}</string>`,
        `        <string>${escapeXml(launcherPath)}</string>`,
        '    </array>',
        '    <key>EnvironmentVariables</key>',
        '    <dict>',
        ...getObjectTypedEntries(env).flatMap(
            ([
                key,
                value,
            ]) => {
                return [
                    `        <key>${escapeXml(key)}</key>`,
                    `        <string>${escapeXml(value)}</string>`,
                ];
            },
        ),
        '    </dict>',
        '    <key>RunAtLoad</key>',
        '    <true/>',
        '    <key>KeepAlive</key>',
        '    <dict>',
        '        <key>SuccessfulExit</key>',
        '        <false/>',
        '    </dict>',
        '    <key>ThrottleInterval</key>',
        '    <integer>30</integer>',
        '    <key>StandardOutPath</key>',
        `    <string>${escapeXml(logPath)}</string>`,
        '    <key>StandardErrorPath</key>',
        `    <string>${escapeXml(logPath)}</string>`,
        '</dict>',
        '</plist>',
        '',
    ].join('\n');
}

/** Quotes a value for a systemd unit file, where `%` starts a specifier. */
function quoteSystemdValue(value: string) {
    return `"${value
        .replaceAll('\\', '\\\\')
        .replaceAll('"', String.raw`\"`)
        .replaceAll('%', '%%')}"`;
}

/**
 * The `systemd --user` unit that runs the launcher. `KillMode=process` stops only the launcher,
 * because systemd otherwise kills every process the unit started, and that includes the pty daemon
 * holding every open terminal.
 */
export function buildSystemdUnit({
    nodePath,
    launcherPath,
    logPath,
    env,
}: Readonly<LoginItemParams>) {
    return [
        '[Unit]',
        'Description=agent-storm',
        '',
        '[Service]',
        `ExecStart=${quoteSystemdValue(nodePath)} ${quoteSystemdValue(launcherPath)}`,
        ...getObjectTypedEntries(env).map(
            ([
                key,
                value,
            ]) => {
                return `Environment=${quoteSystemdValue(
                    [
                        key,
                        value,
                    ].join('='),
                )}`;
            },
        ),
        'Restart=on-failure',
        'RestartSec=30',
        'KillMode=process',
        `StandardOutput=append:${logPath.replaceAll('%', '%%')}`,
        `StandardError=append:${logPath.replaceAll('%', '%%')}`,
        '',
        '[Install]',
        'WantedBy=default.target',
        '',
    ].join('\n');
}

type LoginItemPlatform = {
    filePath: string;
    buildFile(params: Readonly<LoginItemParams>): string;
} & PartialWithUndefined<{
    /** Runs after the file is written. */
    register(): Promise<void>;
    /** Runs before the file is removed. */
    unregister(): Promise<void>;
}>;

const systemdUnitName = 'agent-storm.service';

/**
 * Where start at login is supported. Neither registers in a way that starts the launcher now, since
 * the launcher that asked for it is already running and holds the port.
 */
const loginItemPlatforms: Readonly<Record<OperatingSystem, LoginItemPlatform | undefined>> = {
    /** Launchd loads every file in `~/Library/LaunchAgents` at login. */
    [OperatingSystem.Mac]: {
        filePath: resolve(homedir(), 'Library', 'LaunchAgents', `${loginItemLabel}.plist`),
        buildFile: buildLaunchAgentPlist,
    },
    [OperatingSystem.Linux]: {
        filePath: resolve(homedir(), '.config', 'systemd', 'user', systemdUnitName),
        buildFile: buildSystemdUnit,
        async register() {
            await execFileAsync('systemctl', [
                '--user',
                'daemon-reload',
            ]);
            await execFileAsync('systemctl', [
                '--user',
                'enable',
                systemdUnitName,
            ]);
        },
        async unregister() {
            await execFileAsync('systemctl', [
                '--user',
                'disable',
                systemdUnitName,
            ]);
        },
    },
    [OperatingSystem.Windows]: undefined,
};

export function canInstallLoginItem() {
    return !!loginItemPlatforms[currentOperatingSystem];
}

export async function isLoginItemInstalled() {
    const platform = loginItemPlatforms[currentOperatingSystem];
    return platform
        ? await access(platform.filePath).then(
              () => true,
              () => false,
          )
        : false;
}

/** Makes the launcher start at every login, from the next one on. */
export async function installLoginItem(params: Readonly<LoginItemParams>) {
    const platform = assertWrap.isDefined(
        loginItemPlatforms[currentOperatingSystem],
        `Start at login isn't supported on ${currentOperatingSystem}.`,
    );
    await mkdir(dirname(platform.filePath), {
        recursive: true,
    });
    await writeFile(platform.filePath, platform.buildFile(params));
    await platform.register?.();
}

/**
 * Stops the launcher from starting at login. A launcher the login item already started keeps
 * running.
 */
export async function removeLoginItem() {
    const platform = loginItemPlatforms[currentOperatingSystem];
    if (!platform || !(await isLoginItemInstalled())) {
        return;
    }
    await platform.unregister?.();
    await rm(platform.filePath, {
        force: true,
    });
}
