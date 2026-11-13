import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {buildMarkdownDocument, decodeBase64Text} from './viewer-document.js';

describe(buildMarkdownDocument.name, () => {
    it('renders Markdown to HTML', () => {
        assert.strictEquals(buildMarkdownDocument('# Title').includes('<h1>Title</h1>'), true);
    });

    it('escapes raw HTML and drops script URLs', () => {
        const document = buildMarkdownDocument(
            '<script>alert(1)</script>\n\n[click](javascript:alert(1))',
        );
        assert.deepEquals(
            [
                document.includes('<script>alert'),
                document.includes('javascript:'),
            ],
            [
                false,
                false,
            ],
        );
    });
});

describe(decodeBase64Text.name, () => {
    it('decodes UTF-8 text', () => {
        assert.strictEquals(decodeBase64Text(btoa('cafÃ©')), 'café');
    });
});
