import {agentStormConfigBaseName} from '@agent-storm/bot/src/agent-storm-config.js';
import {botCliCommand, botListShape} from '@agent-storm/bot/src/protocol.js';
import {assert} from '@augment-vir/assert';
import {runCommand} from 'agent-storm-util';
import {findConfigFile} from 'config-vir';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
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

/** Undefined when the repo has no `agent-storm.config` file at its root. */
export async function readRepoConfig(repoPath: string) {
    const configPath = await findConfigFile({
        directory: repoPath,
        baseName: agentStormConfigBaseName,
    });
    if (!configPath) {
        return undefined;
    }
    const contents = await readFile(configPath, 'utf8');
    return {
        configPath,
        contents,
        hash: hashText(contents),
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
