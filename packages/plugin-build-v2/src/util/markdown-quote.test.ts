import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {appendMarkdownQuote} from './markdown-quote.js';

describe(appendMarkdownQuote.name, () => {
    it('quotes every line below the typed message', () => {
        assert.strictEquals(
            appendMarkdownQuote({
                message: 'what about this?\n',
                quote: '\nFirst paragraph\n\nSecond paragraph\n',
            }),
            'what about this?\n\n> First paragraph\n>\n> Second paragraph\n\n',
        );
    });
    it('starts an empty message with the quote', () => {
        assert.strictEquals(
            appendMarkdownQuote({
                message: '',
                quote: 'one line',
            }),
            '> one line\n\n',
        );
    });
});
