import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {createThreadTitle, createWorktreeName, parseGeneratedTitle} from './thread-names.js';

describe(createThreadTitle.name, () => {
    it('uses the first non-empty line', () => {
        assert.strictEquals(createThreadTitle('\n  Fix the build  \nmore detail'), 'Fix the build');
    });

    it('shortens a long line', () => {
        assert.strictEquals(createThreadTitle('word '.repeat(30)), `${'word '.repeat(12).trim()}…`);
    });
});

describe(parseGeneratedTitle.name, () => {
    it('strips quotes, markdown, and a trailing period', () => {
        assert.strictEquals(
            parseGeneratedTitle('\n"**Fix the flaky build.**"\nextra'),
            'Fix the flaky build',
        );
    });

    it('drops a title label', () => {
        assert.strictEquals(parseGeneratedTitle('Title: Add dark mode'), 'Add dark mode');
    });

    it('is undefined for an empty reply', () => {
        assert.isUndefined(parseGeneratedTitle('  \n "" '));
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
