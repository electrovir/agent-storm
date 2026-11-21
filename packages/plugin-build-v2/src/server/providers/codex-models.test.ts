import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {findLegacyCodexModelIds} from './codex-models.js';

describe(findLegacyCodexModelIds.name, () => {
    it('keeps the newest version of each variant', () => {
        assert.deepEquals(
            findLegacyCodexModelIds([
                'gpt-6.2-sol',
                'gpt-6.2-astra',
                'gpt-6.1-terra',
                'gpt-6.1-sol',
                'gpt-6-astra',
                'gpt-6-sol',
                'gpt-6-luna',
                'gpt-5.6-sol',
                'gpt-5.6-terra',
                'gpt-5.6-luna',
                'gpt-5.5',
            ]),
            [
                'gpt-6.1-sol',
                'gpt-6-astra',
                'gpt-6-sol',
                'gpt-5.6-sol',
                'gpt-5.6-terra',
                'gpt-5.6-luna',
                'gpt-5.5',
            ],
        );
    });
    it('keeps ids it cannot parse', () => {
        assert.deepEquals(
            findLegacyCodexModelIds([
                'gpt-6-sol',
                'codex-mini',
            ]),
            [],
        );
    });
});
