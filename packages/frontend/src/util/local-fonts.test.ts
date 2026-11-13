import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {isMonospaceFamily} from './local-fonts.js';

describe(isMonospaceFamily.name, () => {
    it('rejects a family that is not installed', () => {
        assert.isFalse(isMonospaceFamily('Not An Installed Family'));
    });
});
