import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {replaceLegacyKeys} from './migrate-build-plugin-id.js';

describe(replaceLegacyKeys.name, () => {
    it('renames keys that use the legacy id, alone or as a prefix', () => {
        assert.deepEquals(
            replaceLegacyKeys({
                'build-v2': 1,
                'build-v2:thread': 2,
                'agent-storm:build-v2:sidebar': 3,
                terminal: 4,
            }),
            {
                build: 1,
                'build:thread': 2,
                'agent-storm:build:sidebar': 3,
                terminal: 4,
            },
        );
    });
    it("drops the first Build plugin's keys when legacy keys replace them", () => {
        assert.deepEquals(
            replaceLegacyKeys({
                build: 'first',
                'build:thread': 'first',
                'build-v2': 'second',
            }),
            {
                build: 'second',
            },
        );
    });
    it('leaves ids that only start with the legacy id alone', () => {
        assert.isUndefined(
            replaceLegacyKeys({
                'build-v2foo': 1,
                build: 2,
            }),
        );
    });
    it('changes nothing on a second run', () => {
        const migrated = replaceLegacyKeys({
            'build-v2': 1,
        });
        assert.isUndefined(replaceLegacyKeys(migrated));
    });
});
