// cspell:words opencode

import {defaultConfig} from '@agent-storm/common';
import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {getFolderAiCmd, setFolderAiCmd} from './config.js';

describe(getFolderAiCmd.name, () => {
    it('uses folder overrides before the global command', () => {
        const config = {
            ...defaultConfig,
            aiCmd: 'claude',
            folderAiCmds: [
                {
                    folder: '/tmp/project-a',
                    aiCmd: 'codex',
                },
                {
                    folder: '/tmp/project-root',
                    aiCmd: 'opencode',
                },
            ],
        };

        assert.deepEquals(
            {
                overridden: getFolderAiCmd({
                    config,
                    folder: '/tmp/project-a',
                }),
                fallback: getFolderAiCmd({
                    config,
                    folder: '/tmp/project-b',
                }),
                inherited: getFolderAiCmd({
                    config,
                    folder: '/tmp/project-root/worktree-a',
                    fallbackFolders: ['/tmp/project-root'],
                }),
            },
            {
                overridden: 'codex',
                fallback: 'claude',
                inherited: 'opencode',
            },
        );
    });
});

describe(setFolderAiCmd.name, () => {
    it('adds, replaces, and clears folder overrides', () => {
        const config = {
            ...defaultConfig,
            aiCmd: 'claude',
            folderAiCmds: [],
        };
        const withOverride = setFolderAiCmd({
            config,
            folder: '/tmp/project-a',
            aiCmd: 'codex',
        });
        const withReplacement = setFolderAiCmd({
            config: withOverride,
            folder: '/tmp/project-a',
            aiCmd: 'opencode',
        });
        const cleared = setFolderAiCmd({
            config: withReplacement,
            folder: '/tmp/project-a',
            aiCmd: 'claude',
        });

        assert.deepEquals(
            {
                withOverride: withOverride.folderAiCmds,
                withReplacement: withReplacement.folderAiCmds,
                cleared: cleared.folderAiCmds,
            },
            {
                withOverride: [
                    {
                        folder: '/tmp/project-a',
                        aiCmd: 'codex',
                    },
                ],
                withReplacement: [
                    {
                        folder: '/tmp/project-a',
                        aiCmd: 'opencode',
                    },
                ],
                cleared: [],
            },
        );
    });
});
