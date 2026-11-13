import {PluginStatus, type PluginEntry} from '@agent-storm/common';
import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {
    findPluginsTurnedOffByCore,
    isCoreVersionInRange,
    isValidCoreVersionRange,
} from './plugin-compat.js';

function createPlugin({
    id,
    coreVersionRange,
    status,
}: Readonly<{id: string; coreVersionRange: string; status: PluginStatus}>): PluginEntry {
    return {
        id,
        isBuiltIn: false,
        folderName: `${id}-folder`,
        realPath: `/plugins/${id}`,
        isSymlink: false,
        gitRemote: '',
        contentHash: 'hash',
        manifest: {
            id,
            name: `${id} name`,
            description: '',
            browserEntry: 'index.js',
            coreVersionRange,
            panes: [],
            activities: [],
        },
        problem: '',
        status,
    };
}

describe(isCoreVersionInRange.name, () => {
    it('includes a version inside the range', () => {
        assert.isTrue(
            isCoreVersionInRange({
                coreVersion: '1.4.0',
                coreVersionRange: '^1.2.0',
            }),
        );
    });
    it('excludes a version outside the range', () => {
        assert.isFalse(
            isCoreVersionInRange({
                coreVersion: '2.0.0',
                coreVersionRange: '^1.2.0',
            }),
        );
    });
});

describe(isValidCoreVersionRange.name, () => {
    it('accepts a range and rejects text that is not one', () => {
        assert.isTrue(isValidCoreVersionRange('>=1.0.0 <3.0.0'));
        assert.isFalse(isValidCoreVersionRange('latest'));
        assert.isFalse(isValidCoreVersionRange(''));
    });
});

describe(findPluginsTurnedOffByCore.name, () => {
    it('lists only running plugins whose range excludes the version', () => {
        assert.deepEquals(
            findPluginsTurnedOffByCore({
                coreVersion: '2.0.0',
                plugins: [
                    createPlugin({
                        id: 'old',
                        coreVersionRange: '^1.0.0',
                        status: PluginStatus.Active,
                    }),
                    createPlugin({
                        id: 'fine',
                        coreVersionRange: '>=1.0.0',
                        status: PluginStatus.Active,
                    }),
                    createPlugin({
                        id: 'already-off',
                        coreVersionRange: '^1.0.0',
                        status: PluginStatus.Blocked,
                    }),
                ],
            }),
            [
                {
                    pluginId: 'old',
                    name: 'old name',
                    coreVersionRange: '^1.0.0',
                },
            ],
        );
    });
});
