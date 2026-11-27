import {micromark} from 'micromark';

/**
 * Decodes the base64 the server sends. `atob` yields one character per byte, so the bytes are
 * rebuilt before any text decoding.
 */
export function decodeBase64Bytes(contentBase64: string) {
    return Uint8Array.from(atob(contentBase64), (character) => character.codePointAt(0) ?? 0);
}

export function decodeBase64Text(contentBase64: string) {
    return new TextDecoder().decode(decodeBase64Bytes(contentBase64));
}

/**
 * A whole HTML document for a Markdown file. `micromark` escapes raw HTML in the Markdown and drops
 * link and image URLs whose protocol isn't a web one, but the result still belongs in a script-less
 * sandboxed frame instead of the app's own page: that frame is what makes the output safe, and this
 * only keeps it from being unsafe by default.
 */
export function buildMarkdownDocument(markdown: string) {
    return [
        '<!doctype html><meta charset="utf-8"><base target="_blank">',
        '<style>',
        ':root{color-scheme:light dark}',
        'body{font:14px/1.5 system-ui,sans-serif;max-width:800px;margin:0 auto;padding:16px}',
        'img{max-width:100%}',
        'pre,code{font-family:ui-monospace,monospace;font-size:13px}',
        'pre{overflow:auto;padding:12px;border-radius:6px;background:rgba(128,128,128,0.15)}',
        'code{background:rgba(128,128,128,0.15);padding:0 4px;border-radius:3px}',
        'pre code{background:none;padding:0}',
        'blockquote{margin-left:0;padding-left:12px;border-left:3px solid rgba(128,128,128,0.4)}',
        '</style>',
        micromark(markdown),
    ].join('');
}
