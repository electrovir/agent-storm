import {extractExtension} from '@augment-vir/common';
import {HighlightStyle, syntaxHighlighting, type LanguageSupport} from '@codemirror/language';
import {type Extension} from '@codemirror/state';
import {tags} from '@lezer/highlight';

/**
 * File extension (with its leading dot) to the grammar that colors it. Every entry is a dynamic
 * `import()` so a repo of TypeScript never downloads the Python or Markdown grammar — each one is a
 * few tens of kilobytes, and shipping them all up front would undo the size win that motivated
 * dropping the embedded editor.
 */
const languageLoaders: Readonly<Record<string, () => Promise<LanguageSupport>>> = {
    async '.cjs'() {
        return (await import('@codemirror/lang-javascript')).javascript();
    },
    async '.css'() {
        return (await import('@codemirror/lang-css')).css();
    },
    async '.htm'() {
        return (await import('@codemirror/lang-html')).html();
    },
    async '.html'() {
        return (await import('@codemirror/lang-html')).html();
    },
    async '.js'() {
        return (await import('@codemirror/lang-javascript')).javascript();
    },
    async '.json'() {
        return (await import('@codemirror/lang-json')).json();
    },
    async '.jsx'() {
        return (await import('@codemirror/lang-javascript')).javascript({
            jsx: true,
        });
    },
    async '.md'() {
        return (await import('@codemirror/lang-markdown')).markdown();
    },
    async '.mjs'() {
        return (await import('@codemirror/lang-javascript')).javascript();
    },
    async '.mts'() {
        return (await import('@codemirror/lang-javascript')).javascript({
            typescript: true,
        });
    },
    /** Local, so this one is a plain resolve rather than a network fetch. */
    async '.prisma'() {
        return (await import('./prisma-language.js')).prismaLanguageSupport;
    },
    async '.py'() {
        return (await import('@codemirror/lang-python')).python();
    },
    async '.scss'() {
        return (await import('@codemirror/lang-css')).css();
    },
    async '.ts'() {
        return (await import('@codemirror/lang-javascript')).javascript({
            typescript: true,
        });
    },
    async '.tsx'() {
        return (await import('@codemirror/lang-javascript')).javascript({
            jsx: true,
            typescript: true,
        });
    },
    async '.yaml'() {
        return (await import('@codemirror/lang-yaml')).yaml();
    },
    async '.yml'() {
        return (await import('@codemirror/lang-yaml')).yaml();
    },
};

/**
 * The Vir Colors VS Code theme's `tokenColors`, translated from TextMate scopes onto the Lezer tags
 * CodeMirror highlights by. Not a mechanical port — TextMate scopes are finer-grained than Lezer
 * tags, so where several scopes collapse onto one tag the more common language wins. Tags with no
 * entry inherit the editor's foreground, which is what the theme does for plain identifiers (its
 * `Variables` rule is commented out deliberately).
 *
 * Property names are one of those deliberate omissions. The theme's `Properties` rule scopes
 * `meta.function-call.arguments`, which VS Code's TypeScript grammar never emits — so properties
 * are plain foreground there, and mapping the rule onto `tags.propertyName` here would color every
 * `key:` red in a file VS Code leaves alone.
 */
const virColorsHighlightStyle = HighlightStyle.define([
    {
        tag: tags.comment,
        color: '#6C6',
        fontStyle: 'italic',
        fontWeight: '700',
    },
    /**
     * The theme's darker green is scoped to `comment.block.documentation`, which in VS Code means a
     * `/** *\/` block. Lezer has no such distinction — every `/* *\/` comment is a `blockComment`
     * and `docComment` is never produced by the JavaScript grammar — so the whole block-comment tag
     * takes the documentation color. In a codebase whose block comments are all JSDoc that lands on
     * VS Code's rendering; a plain `/* *\/` aside is the rare miss. Bold italic carries over from
     * the `comment` rule above, which is how VS Code resolves it too: font style and foreground are
     * matched independently, so the more specific rule setting only a color keeps the emphasis.
     */
    {
        tag: [
            tags.blockComment,
            tags.docComment,
        ],
        color: '#448C27',
    },
    {
        tag: tags.keyword,
        color: '#4B83CD',
    },
    {
        tag: [
            tags.controlKeyword,
            tags.moduleKeyword,
            tags.logicOperator,
        ],
        color: '#a626a4',
    },
    {
        tag: tags.operator,
        color: '#383a42',
    },
    {
        tag: [
            tags.typeName,
            tags.typeOperator,
        ],
        color: '#7A3E9D',
    },
    {
        tag: [
            tags.className,
            tags.definition(tags.className),
        ],
        color: '#7A3E9D',
        fontWeight: '700',
    },
    {
        tag: [
            tags.function(tags.variableName),
            tags.function(tags.propertyName),
            tags.function(tags.definition(tags.variableName)),
            /**
             * Prisma's `@id` / `@@unique` attributes, which the VS Code extension scopes as
             * `entity.name.function` — the theme's methods rule, so they take the same blue.
             */
            tags.annotation,
        ],
        color: '#4078f2',
    },
    {
        tag: [
            tags.number,
            tags.bool,
            tags.atom,
            tags.self,
            tags.standard(tags.name),
        ],
        color: '#986801',
    },
    {
        tag: [
            tags.string,
            tags.special(tags.string),
        ],
        color: '#50a14f',
    },
    {
        tag: tags.escape,
        color: '#777777',
    },
    {
        tag: tags.regexp,
        color: '#4B83CD',
    },
    {
        tag: tags.character,
        color: '#AB6526',
    },
    {
        tag: [
            tags.punctuation,
            tags.paren,
            tags.bracket,
        ],
        color: '#383a42',
    },
    {
        tag: tags.tagName,
        color: '#4B83CD',
    },
    {
        tag: tags.angleBracket,
        color: '#91B3E0',
    },
    {
        tag: tags.attributeName,
        color: '#91B3E0',
        fontStyle: 'italic',
    },
    {
        tag: [
            tags.invalid,
            tags.deleted,
        ],
        color: '#660000',
    },
    {
        tag: tags.heading,
        color: '#AA3731',
    },
    {
        tag: tags.strong,
        color: '#448C27',
        fontWeight: '700',
    },
    {
        tag: tags.emphasis,
        color: '#448C27',
        fontStyle: 'italic',
    },
    {
        tag: [
            tags.link,
            tags.url,
        ],
        color: '#4B83CD',
    },
    {
        tag: tags.list,
        color: '#4B83CD',
    },
    {
        tag: tags.quote,
        color: '#7A3E9D',
    },
    {
        tag: tags.monospace,
        color: '#AB6526',
    },
]);

/**
 * Editor extensions that color one file's contents. An unrecognized extension still gets the
 * highlight style, which is harmless — with no grammar to produce tokens it simply colors nothing,
 * and the file renders as plain text rather than as an error.
 */
export async function loadSyntaxExtensions(path: string): Promise<Extension[]> {
    const loader = languageLoaders[extractExtension(path).extension.toLowerCase()];
    const support = loader ? await loader().catch(() => undefined) : undefined;
    return [
        syntaxHighlighting(virColorsHighlightStyle, {
            fallback: true,
        }),
        ...(support ? [support] : []),
    ];
}
