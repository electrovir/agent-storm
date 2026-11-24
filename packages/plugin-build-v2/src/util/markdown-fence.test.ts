import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {splitTrailingFences} from './markdown-fence.js';

describe(splitTrailingFences.name, () => {
    it('moves a fence that ends a line of text onto its own line', () => {
        assert.strictEquals(
            splitTrailingFences("Here's one: ```\n>quote\nmore\n```\n\nIs that accurate?"),
            "Here's one:\n```\n>quote\nmore\n```\n\nIs that accurate?",
        );
    });
    it('leaves inline code and unclosed fences alone', () => {
        assert.strictEquals(
            splitTrailingFences('use ```a``` inline\nno close ```\nstuff'),
            'use ```a``` inline\nno close ```\nstuff',
        );
    });
    it('leaves a trailing fence alone when the next fence line opens another block', () => {
        assert.strictEquals(
            splitTrailingFences('Fences look like ```\n\nHere is code:\n```js\nx\n```'),
            'Fences look like ```\n\nHere is code:\n```js\nx\n```',
        );
    });
    it('leaves text inside an existing code block alone', () => {
        assert.strictEquals(
            splitTrailingFences('```\ninside text ```\n```\nafter'),
            '```\ninside text ```\n```\nafter',
        );
    });
});
