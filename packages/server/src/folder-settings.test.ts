import {ForgeType} from '@agent-storm/common';
import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readFolderSettingsFiles} from './folder-settings.js';

async function readSettingsFile({
    fileName,
    contents,
}: Readonly<{
    fileName: string;
    contents: string;
}>) {
    const folder = await mkdtemp(join(tmpdir(), 'agent-storm-folder-settings-'));
    try {
        await mkdir(join(folder, '.agent-storm'));
        await writeFile(join(folder, '.agent-storm', fileName), contents);
        const files = await readFolderSettingsFiles(folder);
        return files.map((file) => {
            return {
                folderSettings: file.folderSettings,
                hasProblem: !!file.problem,
            };
        });
    } finally {
        await rm(folder, {
            recursive: true,
            force: true,
        });
    }
}

const dataFields = {
    defaultAiId: 'repo-ai',
    forges: {
        [ForgeType.Github]: {
            trustedBotLogins: [
                'repo-bot',
            ],
        },
    },
};

describe(readFolderSettingsFiles.name, () => {
    it('reads data fields without a problem', async () => {
        assert.deepEquals(
            await readSettingsFile({
                fileName: 'settings.json',
                contents: JSON.stringify(dataFields),
            }),
            [
                {
                    folderSettings: dataFields,
                    hasProblem: false,
                },
            ],
        );
    });
    it('holds back fields that run commands', async () => {
        assert.deepEquals(
            await readSettingsFile({
                fileName: 'settings.json',
                contents: JSON.stringify({
                    ...dataFields,
                    postWorktreeCmd: 'npm ci',
                    review: {
                        initCmd: 'npm ci',
                    },
                    aiDefinitions: [
                        {
                            id: 'repo-ai',
                            name: 'Repo AI',
                            newSessionCommand: 'repo-ai',
                            resumeSessionCommand: 'repo-ai --continue',
                        },
                    ],
                }),
            }),
            [
                {
                    folderSettings: dataFields,
                    hasProblem: true,
                },
            ],
        );
    });
    it('skips TS settings files', async () => {
        assert.deepEquals(
            await readSettingsFile({
                fileName: 'settings.ts',
                contents: 'export default {};',
            }),
            [
                {
                    folderSettings: undefined,
                    hasProblem: true,
                },
            ],
        );
    });
    it('skips an invalid file', async () => {
        assert.deepEquals(
            await readSettingsFile({
                fileName: 'settings.json',
                contents: JSON.stringify({
                    defaultAiId: 5,
                }),
            }),
            [
                {
                    folderSettings: undefined,
                    hasProblem: true,
                },
            ],
        );
    });
});
