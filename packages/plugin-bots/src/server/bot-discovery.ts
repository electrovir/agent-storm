import {botCliCommand, botListShape} from '@agent-storm/bot/src/protocol.js';
import {agentStormConfigBaseName} from '@agent-storm/config';
import {assert, assertWrap, check} from '@augment-vir/assert';
import {getObjectTypedValues} from '@augment-vir/common';
import {runCommand} from 'agent-storm-util';
import {deduceFileType, findConfigFile, rawFileContentParsers} from 'config-vir';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {assertValidShape} from 'object-shape-tester';

function hashText(text: string) {
    return createHash('sha256').update(text).digest('hex');
}

/** Stable across restarts, and safe as a file name and a route path. */
export function createBotId({
    repoPath,
    name,
}: Readonly<{
    repoPath: string;
    name: string;
}>) {
    return hashText(`${repoPath}\0${name}`).slice(0, 16);
}

/** Same as {@link createBotId} for a repo. */
export function createRepoId(repoPath: string) {
    return hashText(repoPath).slice(0, 16);
}

/**
 * Undefined when the repo has no `.agent-storm/agent-storm.config` file with bots. `hash` is what
 * the user approves: it covers the config and the bot files it names by path, but not what those
 * import.
 */
export async function readRepoConfig(repoPath: string) {
    const configPath = await findConfigFile({
        directory: repoPath,
        baseName: agentStormConfigBaseName,
    });
    if (!configPath) {
        return undefined;
    }
    const contents = await readFile(configPath, 'utf8');
    /**
     * The file also holds folder settings, so it may have no bots. Only a JSON, YAML, or TOML one
     * can be checked here: reading a TS or JS one runs it, which waits for the user's approval.
     */
    const parseData = rawFileContentParsers[assertWrap.isDefined(deduceFileType(configPath))];
    const data: unknown = parseData?.({
        rawContents: contents,
    });
    if (parseData && !(check.isObject(data) && check.hasKey(data, 'bots'))) {
        return undefined;
    }
    /** Resolved the way `@agent-storm/bot`'s `loadBot` imports them. */
    const botFiles = await Promise.all(
        (check.isObject(data) && check.hasKey(data, 'bots') && check.isObject(data.bots)
            ? getObjectTypedValues(data.bots).filter(check.isString)
            : []
        ).map(async (botPath) => {
            return {
                botPath,
                contents: await readFile(resolve(dirname(configPath), botPath), 'utf8').catch(
                    () => undefined,
                ),
            };
        }),
    );
    return {
        configPath,
        contents,
        hash: hashText(
            JSON.stringify({
                contents,
                botFiles,
            }),
        ),
    };
}

/** Runs the repo's own `agent-storm-bot --list`, which loads its config. */
export async function listRepoBots(repoPath: string) {
    const commandParts = botCliCommand.split(' ');
    assert.isLengthAtLeast(commandParts, 1);
    const [
        command,
        ...args
    ] = commandParts;
    const {stdout} = await runCommand(
        command,
        [
            ...args,
            '--list',
        ],
        {
            cwd: repoPath,
            timeout: {
                minutes: 1,
            },
        },
    );
    /** Anything the config logs while it loads comes before the list. */
    const lastLine = stdout.trim().split('\n').at(-1) || '';
    const list: unknown = JSON.parse(lastLine);
    assertValidShape(list, botListShape);
    return list;
}
