import {check} from '@augment-vir/assert';
import {getObjectTypedEntries, getObjectTypedValues, log} from '@augment-vir/common';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {
    claudeHookInstallDir,
    claudeHookSourceDir,
    claudeSettingsPath,
    instanceName,
} from './file-paths.js';
import {writeFileAtomically} from './write-file-atomically.js';

enum ClaudeHookScript {
    Session = 'agent-storm-session.sh',
    Activity = 'agent-storm-activity.sh',
}

enum ClaudeHookEvent {
    SessionStart = 'SessionStart',
    UserPromptSubmit = 'UserPromptSubmit',
    PreToolUse = 'PreToolUse',
    PostToolUse = 'PostToolUse',
    PostToolUseFailure = 'PostToolUseFailure',
    SubagentStart = 'SubagentStart',
    SubagentStop = 'SubagentStop',
    Notification = 'Notification',
    Stop = 'Stop',
    StopFailure = 'StopFailure',
}

const hookEventsByScript: Record<ClaudeHookScript, ReadonlyArray<ClaudeHookEvent>> = {
    [ClaudeHookScript.Session]: [
        ClaudeHookEvent.SessionStart,
    ],
    [ClaudeHookScript.Activity]: getObjectTypedValues(ClaudeHookEvent),
};

/**
 * Commands are matched by exact string, so these must stay identical to what earlier installs (and
 * any hand-written entry) used, or every startup would append a duplicate.
 */
const requiredHooks = getObjectTypedEntries(hookEventsByScript).flatMap(
    ([
        script,
        events,
    ]) => {
        return events.map((event) => {
            return {
                event,
                command: `bash ~/.claude/${script}`,
            };
        });
    },
);

function hasHookCommand(entry: unknown, command: string): boolean {
    return (
        check.isObject(entry) &&
        Array.isArray(entry.hooks) &&
        entry.hooks.some((hook: unknown) => check.isObject(hook) && hook.command === command)
    );
}

/**
 * Same settings with an entry appended for every agent-storm hook it doesn't already run, leaving
 * every existing entry (the user's own hooks included) untouched. Returns `undefined` when nothing
 * is missing, so an up-to-date file is never rewritten.
 */
/** Annotated because spreading an index-signature type infers away every key but `hooks`. */
export function addMissingClaudeHooks(
    settings: Readonly<Record<PropertyKey, unknown>>,
): Record<PropertyKey, unknown> | undefined {
    const hooks = check.isObject(settings.hooks) ? settings.hooks : {};
    const missing = requiredHooks.filter(({event, command}) => {
        const entries: unknown = hooks[event];
        return !(Array.isArray(entries) && entries.some((entry) => hasHookCommand(entry, command)));
    });
    if (!missing.length) {
        return undefined;
    }
    return {
        ...settings,
        hooks: missing.reduce<Record<PropertyKey, unknown>>((updated, {event, command}) => {
            const existing: unknown = updated[event];
            return {
                ...updated,
                [event]: [
                    ...(Array.isArray(existing) ? existing : []),
                    {
                        hooks: [
                            {
                                type: 'command',
                                command,
                            },
                        ],
                    },
                ],
            };
        }, hooks),
    };
}

/**
 * Copy the hook scripts into `~/.claude/` and register them in Claude Code's user settings. AI tabs
 * resume their own chat and report background activity only through these hooks. They can't be
 * passed per launch with `claude --settings` because the user's `claude` shell wrapper skips its
 * resume logic whenever it is given any argument.
 *
 * Failure only costs those features, so it is logged rather than thrown. Settings that fail to
 * parse are left alone rather than replaced.
 */
export async function installClaudeHooks(): Promise<void> {
    /**
     * `~/.claude` belongs to the default instance, and a named one may run from a checkout with
     * different hook scripts. Its tabs run the default instance's hooks, which write wherever the
     * tab's `AGENT_STORM_DATA_DIR` points.
     */
    if (instanceName) {
        return;
    }
    try {
        await mkdir(claudeHookInstallDir, {
            recursive: true,
        });
        await Promise.all(
            getObjectTypedValues(ClaudeHookScript).map(async (script) => {
                const source = await readFile(join(claudeHookSourceDir, script), 'utf8');
                const installedPath = join(claudeHookInstallDir, script);
                const installed = await readFile(installedPath, 'utf8').catch(() => undefined);
                if (installed !== source) {
                    await writeFile(installedPath, source);
                }
            }),
        );
        const settingsText = await readFile(claudeSettingsPath, 'utf8').catch(() => undefined);
        const settings: unknown = settingsText == undefined ? {} : JSON.parse(settingsText);
        if (!check.isObject(settings)) {
            throw new TypeError(`${claudeSettingsPath} does not hold a JSON object.`);
        }
        const updated = addMissingClaudeHooks(settings);
        if (!updated) {
            return;
        }
        await writeFileAtomically({
            path: claudeSettingsPath,
            contents: `${JSON.stringify(updated, undefined, 2)}\n`,
            /** Claude Code creates this file owner-only, and it can hold credentials. */
            mode: 0o600,
        });
    } catch (error) {
        log.warning(`Failed to install Claude hooks: ${String(error)}`);
    }
}
