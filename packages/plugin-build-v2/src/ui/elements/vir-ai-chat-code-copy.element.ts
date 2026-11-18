import {defineAppElement} from '@agent-storm/core/frontend';
import {wait} from '@augment-vir/common';
import {css, html, listen} from 'element-vir';
import {
    createSizedIcon,
    LucideCopyCheckIcon,
    LucideCopyIcon,
    tooltip,
    ViraButton,
    ViraColorVariant,
    ViraEmphasis,
    ViraSize,
} from 'vira';

const copyIcon = createSizedIcon(LucideCopyIcon, 14);
const copiedIcon = createSizedIcon(LucideCopyCheckIcon, 14);

/**
 * Copies the full text of the `chat-markdown-codeblock` it sits in. Placed by tag name inside the
 * HTML string that `renderChatMarkdown` produces, so it takes no inputs.
 */
export const VirAiChatCodeCopy = defineAppElement()({
    tagName: 'vir-ai-chat-code-copy',
    styles: css`
        :host {
            display: flex;
            user-select: none;
        }
    `,
    state() {
        return {
            isCopied: false,
        };
    },
    render({host, state, updateState}) {
        return html`
            <${ViraButton.assign({
                buttonSize: ViraSize.Small,
                buttonEmphasis: ViraEmphasis.Subtle,
                color: ViraColorVariant.Neutral,
                icon: state.isCopied ? copiedIcon : copyIcon,
            })}
                ${tooltip('Copy the full code block.')}
                ${listen('click', async () => {
                    await navigator.clipboard.writeText(
                        host.closest('.chat-markdown-codeblock')?.querySelector('pre')
                            ?.textContent || '',
                    );
                    updateState({
                        isCopied: true,
                    });
                    await wait({
                        seconds: 2,
                    });
                    updateState({
                        isCopied: false,
                    });
                })}
            ></${ViraButton}>
        `;
    },
});
