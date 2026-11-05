import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {isSafeBranchName} from './branch-name.js';

describe(isSafeBranchName.name, () => {
    it('accepts ordinary branch names', () => {
        assert.isTrue(
            [
                'main',
                'feature/one',
                'user/ABC-123_fix.v2',
                'release/2026.11',
            ].every(isSafeBranchName),
        );
    });

    it('rejects branch names that could escape a path, inject a flag, or smuggle text', () => {
        assert.deepEquals(
            [
                '',
                '..',
                '../etc',
                'a/../b',
                'a..b',
                '-rf',
                '--upload-pack=touch',
                '/absolute',
                'a//b',
                'trailing/',
                'refs.lock',
                'a/b.lock/c',
                '.hidden',
                'a/.git',
                'dot.',
                'with space',
                'a;rm -rf ~',
                '$(id)',
                'a`id`',
                'line\nbreak',
                'escape\u001B[31m',
                'tab\there',
                'café',
                '~home',
                'a:b',
                String.raw`back\slash`,
                'a@{0}',
            ].filter(isSafeBranchName),
            [],
        );
    });
});
