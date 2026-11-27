import {FolderSettingsApproval, ForgeType} from '@agent-storm/common';
import {assert} from '@augment-vir/assert';
import {type PartialWithUndefined} from '@augment-vir/common';
import {describe, it} from '@augment-vir/test';
import {createHash} from 'node:crypto';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readFolderSettingsFiles} from './folder-settings.js';

async function readSettingsFile({
    fileName,
    contents,
    isApproved,
}: Readonly<{
    fileName: string;
    contents: string;
}> &
    PartialWithUndefined<{
        isApproved: boolean;
    }>) {
    const folder = await mkdtemp(join(tmpdir(), 'agent-storm-folder-settings-'));
    try {
        await mkdir(join(folder, '.agent-storm'));
        await writeFile(
            join(folder, 'package.json'),
            JSON.stringify({
                type: 'module',
            }),
        );
        const path = join(folder, '.agent-storm', fileName);
        await writeFile(path, contents);
        const files = await readFolderSettingsFiles({
            folder,
            approvals: isApproved
                ? [
                      {
                          path,
                          contentHash: createHash('sha256').update(contents).digest('hex'),
                      },
                  ]
                : [],
        });
        return files.map((file) => {
            return {
                folderSettings: file.folderSettings,
                approval: file.approval,
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
    forges: {
        [ForgeType.Github]: {
            trustedBotLogins: [
                'repo-bot',
            ],
        },
    },
};

const commandFields = {
    postWorktreeCmd: 'npm ci',
    review: {
        initCmd: 'npm ci',
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
                    approval: FolderSettingsApproval.NotNeeded,
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
                    ...commandFields,
                }),
            }),
            [
                {
                    folderSettings: dataFields,
                    approval: FolderSettingsApproval.NeedsApproval,
                    hasProblem: true,
                },
            ],
        );
    });
    it('applies fields that run commands once approved', async () => {
        assert.deepEquals(
            await readSettingsFile({
                fileName: 'settings.json',
                contents: JSON.stringify({
                    ...dataFields,
                    ...commandFields,
                }),
                isApproved: true,
            }),
            [
                {
                    folderSettings: {
                        ...dataFields,
                        ...commandFields,
                    },
                    approval: FolderSettingsApproval.Approved,
                    hasProblem: false,
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
                    approval: FolderSettingsApproval.NeedsApproval,
                    hasProblem: true,
                },
            ],
        );
    });
    it('runs an approved TS settings file', async () => {
        assert.deepEquals(
            await readSettingsFile({
                fileName: 'settings.ts',
                contents: `export default ${JSON.stringify(dataFields)};`,
                isApproved: true,
            }),
            [
                {
                    folderSettings: dataFields,
                    approval: FolderSettingsApproval.Approved,
                    hasProblem: false,
                },
            ],
        );
    });
    it('skips an invalid file', async () => {
        assert.deepEquals(
            await readSettingsFile({
                fileName: 'settings.json',
                contents: JSON.stringify({
                    forges: 5,
                }),
            }),
            [
                {
                    folderSettings: undefined,
                    approval: FolderSettingsApproval.NotNeeded,
                    hasProblem: true,
                },
            ],
        );
    });
});
