import {assert} from '@augment-vir/assert';
import {getObjectTypedEntries} from '@augment-vir/common';
import {describe, it} from '@augment-vir/test';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {resolveAgentStormConfig} from './resolve-agent-storm-config.js';

async function withConfigFiles(
    files: Readonly<Record<string, string>>,
    callback: (root: string) => Promise<void>,
) {
    const root = await mkdtemp(join(tmpdir(), 'agent-storm-config-'));
    try {
        await Promise.all(
            getObjectTypedEntries(files).map(
                async ([
                    path,
                    contents,
                ]) => {
                    await mkdir(dirname(join(root, path)), {
                        recursive: true,
                    });
                    await writeFile(join(root, path), contents);
                },
            ),
        );
        await callback(root);
    } finally {
        await rm(root, {
            recursive: true,
            force: true,
        });
    }
}

describe(resolveAgentStormConfig.name, () => {
    it('takes each setting from the nearest file that sets it', async () => {
        await withConfigFiles(
            {
                'repo/.agent-storm/agent-storm.config.yaml':
                    "reviewSkill: '/review-branch'\npostWorktreeCmd: npm ci\n",
                'repo/packages/app/.agent-storm/agent-storm.config.json': JSON.stringify({
                    reviewSkill: '/review-branch local',
                    postWorktreeCmd: ' ',
                }),
                'repo/packages/app/src/.keep': '',
            },
            async (root) => {
                assert.deepEquals(
                    await resolveAgentStormConfig(join(root, 'repo', 'packages', 'app', 'src')),
                    {
                        configPaths: [
                            join(root, 'repo/packages/app/.agent-storm/agent-storm.config.json'),
                            join(root, 'repo/.agent-storm/agent-storm.config.yaml'),
                        ],
                        skippedConfigPaths: [],
                        postWorktreeCmd: 'npm ci',
                        reviewSkill: '/review-branch local',
                    },
                );
            },
        );
    });
    it('skips a TS config without running it', async () => {
        await withConfigFiles(
            {
                'repo/.agent-storm/agent-storm.config.ts':
                    "throw new Error('ran');\nexport default {reviewSkill: '/review-branch'};\n",
            },
            async (root) => {
                assert.deepEquals(await resolveAgentStormConfig(join(root, 'repo')), {
                    configPaths: [],
                    skippedConfigPaths: [
                        join(root, 'repo/.agent-storm/agent-storm.config.ts'),
                    ],
                    postWorktreeCmd: '',
                    reviewSkill: '',
                });
            },
        );
    });
    it('rejects an invalid config', async () => {
        await withConfigFiles(
            {
                'repo/.agent-storm/agent-storm.config.toml': 'reviewSkill = 5\n',
            },
            async (root) => {
                await assert.throws(resolveAgentStormConfig(join(root, 'repo')), {
                    matchMessage: "isn't a valid Agent Storm config",
                });
            },
        );
    });
});
