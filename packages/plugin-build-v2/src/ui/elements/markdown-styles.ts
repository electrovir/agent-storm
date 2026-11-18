import {classMap, css, html, unsafeHTML} from 'element-vir';
import {micromark} from 'micromark';
import {gfm, gfmHtml} from 'micromark-extension-gfm';
import {viraThemeByKeys} from 'vira';
import {VirAiChatCodeCopy} from './vir-ai-chat-code-copy.element.js';

const codeBlockPattern = /<pre><code(?: class="language-([^"]*)")?>([\s\S]*?)<\/code><\/pre>/g;

/** Single newlines outside code fences become hard breaks. */
function preserveLineBreaks(text: string) {
    return text
        .split(/((?:^|\n)(?:```|~~~)[\s\S]*?(?:\n(?:```|~~~)|$))/g)
        .map((part, index) => {
            return index % 2 === 1 ? part : part.replaceAll(/([^\n])\n(?=[^\n])/g, '$1  \n');
        })
        .join('');
}

function wrapCodeBlocks(markupHtml: string) {
    return markupHtml.replaceAll(codeBlockPattern, (_match, language = 'text', code) => {
        return [
            `<div class="chat-markdown-codeblock" data-language="${language}">`,
            `<div class="chat-markdown-codeblock-header"><span>${language}</span><${VirAiChatCodeCopy.tagName}></${VirAiChatCodeCopy.tagName}></div>`,
            `<pre><code>${code}</code></pre>`,
            '</div>',
        ].join('');
    });
}

/**
 * Styles for `renderChatMarkdown`'s output. Include them in the styles of the element that renders
 * it.
 */
export const chatMarkdownStyles = css`
    .chat-markdown {
        width: 100%;
        min-width: 0;
        overflow-wrap: anywhere;
        word-break: break-word;

        &.is-block {
            font-size: 14px;
            color: ${viraThemeByKeys.grey.foreground.body.foreground.value};
        }

        & > :first-child {
            margin-top: 0;
        }

        & > :last-child {
            margin-bottom: 0;
        }

        & p,
        & ul,
        & ol,
        & blockquote,
        & pre {
            margin: 0.65rem 0;
        }

        & h1,
        & h2,
        & h3,
        & h4,
        & h5,
        & h6 {
            margin: 1.25rem 0 0.5rem;
            font-weight: 600;
            color: ${viraThemeByKeys.grey.foreground['highest-contrast'].foreground.value};
        }

        & h1 {
            font-size: 1.25rem;
        }

        & h2 {
            font-size: 1.125rem;
        }

        & h3 {
            font-size: 1rem;
        }

        & h4,
        & h5,
        & h6 {
            font-size: 0.875rem;
        }

        & h6 {
            color: ${viraThemeByKeys.grey.foreground['non-body'].foreground.value};
        }

        & ul,
        & ol {
            padding-inline-start: 1.25rem;
        }

        & ul {
            list-style-type: disc;

            & ul {
                list-style-type: circle;

                & ul {
                    list-style-type: square;
                }
            }
        }

        & ol {
            list-style-type: decimal;

            & ol {
                list-style-type: lower-alpha;

                & ol {
                    list-style-type: lower-roman;
                }
            }
        }

        & li + li {
            margin-top: 0.25rem;
        }

        & img {
            display: inline-block;
            max-width: 100%;
        }

        & a {
            text-decoration: none;
            color: ${viraThemeByKeys.blue.foreground.body.foreground.value};

            &:hover,
            &:focus-visible {
                text-decoration: underline;
            }
        }

        & blockquote {
            border-inline-start: 2px solid
                ${viraThemeByKeys.grey.foreground.decoration.foreground.value};
            padding-inline-start: 0.8rem;
        }

        & hr {
            border: none;
            border-top: 1px solid ${viraThemeByKeys.grey.foreground.decoration.foreground.value};
        }

        & table {
            border-collapse: collapse;
            display: block;
            max-width: 100%;
            overflow-x: auto;

            & th,
            & td {
                padding: 4px 10px;
                text-align: start;
                border: 1px solid ${viraThemeByKeys.grey.foreground.decoration.foreground.value};

                &[align='center'] {
                    text-align: center;
                }

                &[align='right'] {
                    text-align: end;
                }
            }

            & th {
                font-weight: 600;
            }
        }

        & :not(pre) > code {
            font-family: monospace;
            font-size: 0.85em;
            padding: 0.1em 0.35em;
            border-radius: 4px;
            border: 1px solid ${viraThemeByKeys.grey.foreground.decoration.foreground.value};
            background-color: ${viraThemeByKeys.grey['behind-fg']['small-body'].background.value};
        }

        & .chat-markdown-codeblock {
            margin: 0.65rem 0;
            overflow: hidden;
            border-radius: 8px;
            border: 1px solid ${viraThemeByKeys.grey.foreground.decoration.foreground.value};
            background-color: ${viraThemeByKeys.grey['behind-fg']['small-body'].background.value};

            & .chat-markdown-codeblock-header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 6px 6px 0 12px;
                font-family: monospace;
                font-size: 11px;
                user-select: none;
                color: ${viraThemeByKeys.grey.foreground['non-body'].foreground.value};
            }

            & pre {
                margin: 0;
                padding: 8px 12px 10px;
                overflow-x: auto;
                font-size: 12px;
                font-family: monospace;
            }
        }
    }
`;

/** Renders Markdown inside the `chat-markdown` root that `chatMarkdownStyles` targets. */
export function renderChatMarkdown({
    text,
    className,
    isInline,
    hasLineBreaks,
}: Readonly<{
    text: string;
    className?: string;
    isInline?: boolean;
    hasLineBreaks?: boolean;
}>) {
    return html`
        <div
            class=${classMap({
                'chat-markdown': true,
                'is-block': !isInline,
                ...(className
                    ? {
                          [className]: true,
                      }
                    : {}),
            })}
        >
            ${unsafeHTML(
                wrapCodeBlocks(
                    micromark(hasLineBreaks ? preserveLineBreaks(text) : text, {
                        extensions: [
                            gfm(),
                        ],
                        htmlExtensions: [
                            gfmHtml(),
                        ],
                    }),
                ),
            )}
        </div>
    `;
}
