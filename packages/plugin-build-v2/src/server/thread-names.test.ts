import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {createThreadTitle, createWorktreeName} from './thread-names.js';

describe(createThreadTitle.name, () => {
    it('uses the first non-empty line', () => {
        assert.strictEquals(createThreadTitle('\n  Fix the build  \nmore detail'), 'Fix the build');
    });

    it('shortens a long line', () => {
        assert.strictEquals(createThreadTitle('word '.repeat(30)), `${'word '.repeat(12).trim()}…`);
    });
});

describe(createWorktreeName.name, () => {
    it('slugs the title and adds a suffix', () => {
        assert.matches(createWorktreeName('Fix: the Build!'), /^fix-the-build-[a-z0-9]{6}$/);
    });

    it('falls back for a title with no letters or digits', () => {
        assert.matches(createWorktreeName('???'), /^thread-[a-z0-9]{6}$/);
    });
});
