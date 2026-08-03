import {extractExtension} from '@augment-vir/common';
import {
    defaultHighlightStyle,
    syntaxHighlighting,
    type LanguageSupport,
} from '@codemirror/language';
import {type Extension} from '@codemirror/state';

/**
 * File extension (with its leading dot) to the grammar that colors it. Every entry is a dynamic
 * `import()` so a repo of TypeScript never downloads the Python or Markdown grammar — each one is a
 * few tens of kilobytes, and shipping them all up front would undo the size win that motivated
 * dropping the embedded editor.
 */
const languageLoaders: Readonly<Record<string, () => Promise<LanguageSupport>>> = {
    '.cjs': async () => (await import('@codemirror/lang-javascript')).javascript(),
    '.css': async () => (await import('@codemirror/lang-css')).css(),
    '.htm': async () => (await import('@codemirror/lang-html')).html(),
    '.html': async () => (await import('@codemirror/lang-html')).html(),
    '.js': async () => (await import('@codemirror/lang-javascript')).javascript(),
    '.json': async () => (await import('@codemirror/lang-json')).json(),
    '.jsx': async () =>
        (await import('@codemirror/lang-javascript')).javascript({
            jsx: true,
        }),
    '.md': async () => (await import('@codemirror/lang-markdown')).markdown(),
    '.mjs': async () => (await import('@codemirror/lang-javascript')).javascript(),
    '.mts': async () =>
        (await import('@codemirror/lang-javascript')).javascript({
            typescript: true,
        }),
    '.py': async () => (await import('@codemirror/lang-python')).python(),
    '.scss': async () => (await import('@codemirror/lang-css')).css(),
    '.ts': async () =>
        (await import('@codemirror/lang-javascript')).javascript({
            typescript: true,
        }),
    '.tsx': async () =>
        (await import('@codemirror/lang-javascript')).javascript({
            jsx: true,
            typescript: true,
        }),
    '.yaml': async () => (await import('@codemirror/lang-yaml')).yaml(),
    '.yml': async () => (await import('@codemirror/lang-yaml')).yaml(),
};

/**
 * Editor extensions that color one file's contents. An unrecognized extension still gets the
 * highlight style, which is harmless — with no grammar to produce tokens it simply colors nothing,
 * and the file renders as plain text rather than as an error.
 */
export async function loadSyntaxExtensions(path: string): Promise<Extension[]> {
    const loader = languageLoaders[extractExtension(path).extension.toLowerCase()];
    const support = loader ? await loader().catch(() => undefined) : undefined;
    return [
        syntaxHighlighting(defaultHighlightStyle, {
            fallback: true,
        }),
        ...(support ? [support] : []),
    ];
}
