import {defineAppElement} from '@agent-storm/core/frontend';
import {asyncProp, css, defineElementEvent, html, listen, onDomCreated} from 'element-vir';
import {createSizedIcon, LucideXIcon, ViraButton, ViraColorVariant, viraThemeByKeys} from 'vira';
import {buildV2Client} from '../../util/build-v2-client.js';
import {type MessageAttachment} from '../../util/message-attachments.js';
import {VirAiChatImageZoom} from './vir-ai-chat-image-zoom.element.js';

const closeIcon = createSizedIcon(LucideXIcon, 16);

async function loadContent({path, isImage}: Readonly<MessageAttachment>) {
    /** `readUpload` only reads uploads, and an image can also be one a chat message shows. */
    if (isImage) {
        const {mimeType, dataBase64} = await buildV2Client.call('readImage', {
            path,
        });
        return {
            imageUrl: `data:${mimeType};base64,${dataBase64}`,
            text: undefined,
        };
    }

    const {dataBase64} = await buildV2Client.call('readUpload', {
        path,
    });
    const text = await (await fetch(`data:text/plain;base64,${dataBase64}`)).text();
    return {
        imageUrl: undefined,
        /** A NUL character marks a binary file, which has no readable text. */
        text: text.includes('\0') ? undefined : text,
    };
}

/**
 * An attachment at full size, or its full text, filling its nearest positioned ancestor. Escape or
 * the close button (or a click outside an image) emits `closed`.
 */
export const VirAiChatAttachmentViewer = defineAppElement<{
    attachment: Readonly<MessageAttachment>;
}>()({
    tagName: 'vir-ai-chat-attachment-viewer',
    events: {
        closed: defineElementEvent<void>(),
    },
    state() {
        return {
            content: asyncProp({
                updateCallback: loadContent,
            }),
        };
    },
    styles: css`
        :host {
            position: absolute;
            inset: 0;
            z-index: 50;
            display: flex;
        }

        .viewer {
            display: flex;
            flex-direction: column;
            flex-grow: 1;
            min-width: 0;
            min-height: 0;
            background-color: ${viraThemeByKeys.grey['behind-bg'].body.foreground.value};
            outline: none;
        }

        header {
            display: flex;
            align-items: center;
            flex-shrink: 0;
            gap: 12px;
            height: 52px;
            box-sizing: border-box;
            padding: 0 12px;
            border-bottom: 1px solid ${viraThemeByKeys.grey.foreground.decoration.foreground.value};

            & h2 {
                flex-grow: 1;
                min-width: 0;
                margin: 0;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
                font-size: 14px;
            }
        }

        .body {
            position: relative;
            display: flex;
            flex-grow: 1;
            min-height: 0;
            box-sizing: border-box;
            padding: 16px;
            overflow: auto;
        }

        pre {
            margin: 0;
            white-space: pre-wrap;
            overflow-wrap: anywhere;
            font-size: 12px;
        }

        .message {
            color: ${viraThemeByKeys.grey.foreground['non-body'].foreground.value};
        }
    `,
    render({inputs, state, dispatch, events}) {
        state.content.update(inputs.attachment);

        function close() {
            dispatch(
                new events.closed({
                    detail: undefined,
                }),
            );
        }

        function renderBody() {
            if (state.content.isError()) {
                return html`
                    <span class="message">Couldn't read this file.</span>
                `;
            } else if (!state.content.isResolved()) {
                return html`
                    <span class="message">Loading…</span>
                `;
            } else if (state.content.value.imageUrl) {
                return html`
                    <${VirAiChatImageZoom.assign({
                        imageUrl: state.content.value.imageUrl,
                        alt: inputs.attachment.name,
                    })}
                        ${listen(VirAiChatImageZoom.events.outsideClicked, close)}
                    ></${VirAiChatImageZoom}>
                `;
            } else if (state.content.value.text == undefined) {
                return html`
                    <span class="message">No preview for this file.</span>
                `;
            } else {
                return html`
                    <pre>${state.content.value.text}</pre>
                `;
            }
        }

        return html`
            <div
                class="viewer"
                tabindex="-1"
                ${onDomCreated((element) => {
                    if (element instanceof HTMLElement) {
                        element.focus();
                    }
                })}
                ${listen('keydown', (event) => {
                    if (event.key === 'Escape') {
                        event.preventDefault();
                        close();
                    }
                })}
            >
                <header>
                    <h2>${inputs.attachment.name}</h2>
                    <${ViraButton.assign({
                        icon: closeIcon,
                        color: ViraColorVariant.Neutral,
                    })}
                        aria-label="Close"
                        ${listen('click', close)}
                    ></${ViraButton}>
                </header>
                <div class="body">${renderBody()}</div>
            </div>
        `;
    },
});
