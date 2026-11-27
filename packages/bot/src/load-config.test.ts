import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {listBots, loadAgentStormConfig, loadBot} from './load-config.js';

const botModule = `export default {
    description: 'Says hi.',
    interval: {minutes: 5},
    ai: {provider: 'claude', model: 'claude-haiku-5'},
    execute: {prompt: 'Say hi.'},
};
`;

async function withRepo(
    files: Readonly<Record<string, string>>,
    callback: (directory: string) => Promise<void>,
) {
    const directory = await mkdtemp(join(tmpdir(), 'agent-storm-bot-test-'));
    try {
        await Promise.all(
            Object.entries(files).map(
                async ([
                    name,
                    contents,
                ]) => {
                    await writeFile(join(directory, name), contents);
                },
            ),
        );
        await callback(directory);
    } finally {
        await rm(directory, {
            recursive: true,
            force: true,
        });
    }
}

describe(loadAgentStormConfig.name, () => {
    it('loads a JSON config whose bots are module paths', async () => {
        await withRepo(
            {
                'agent-storm.config.json': JSON.stringify({
                    bots: {
                        hello: './hello.bot.ts',
                        missing: './missing.bot.ts',
                    },
                }),
                'hello.bot.ts': botModule,
            },
            async (directory) => {
                const loaded = await loadAgentStormConfig(directory);
                const bot = await loadBot({
                    ...loaded,
                    name: 'hello',
                });
                const listed = await listBots(loaded);
                assert.deepEquals(
                    {
                        description: bot.description,
                        names: listed.bots.map((entry) => entry.name),
                        errors: listed.bots.map((entry) => !!entry.error),
                    },
                    {
                        description: 'Says hi.',
                        names: [
                            'hello',
                            'missing',
                        ],
                        errors: [
                            false,
                            true,
                        ],
                    },
                );
            },
        );
    });
    it('loads a TS config with an inline bot', async () => {
        await withRepo(
            {
                'agent-storm.config.ts': `export default {bots: {inline: ${botModule.replace('export default ', '').replace(/;\n$/, '')}}};\n`,
            },
            async (directory) => {
                const bot = await loadBot({
                    ...(await loadAgentStormConfig(directory)),
                    name: 'inline',
                });
                assert.strictEquals(bot.description, 'Says hi.');
            },
        );
    });
    it('rejects a bot name with spaces', async () => {
        await withRepo(
            {
                'agent-storm.config.json': JSON.stringify({
                    bots: {
                        'bad name': './x.ts',
                    },
                }),
            },
            async (directory) => {
                await assert.throws(loadAgentStormConfig(directory));
            },
        );
    });
});
