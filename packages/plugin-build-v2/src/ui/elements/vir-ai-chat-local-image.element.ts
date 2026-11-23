import {defineAppElement} from '@agent-storm/core/frontend';
import {type AnyDuration} from 'date-vir';
import {asyncProp, css, defineElementEvent, html, listen} from 'element-vir';
import {viraThemeByKeys} from 'vira';
import {buildV2Client} from '../../util/build-v2-client.js';
import {type MessageAttachment} from '../../util/message-attachments.js';

/**
 * A streaming message's HTML is rebuilt on every delta, which makes a new element for each of its
 * images, so a load this recent is shown right away instead of read again.
 */
const imageReuseDuration = {
    milliseconds: 30_000,
} as const satisfies AnyDuration;

const recentImages = new Map<string, Readonly<{imageUrl: string; loadedAt: number}>>();

function isRecent(loadedAt: number) {
    return Date.now() - loadedAt < imageReuseDuration.milliseconds;
}

async function loadImageUrl(path: string) {
    const {mimeType, dataBase64} = await buildV2Client.call('readImage', {
        path,
    });
    const imageUrl = `data:${mimeType};base64,${dataBase64}`;
    recentImages.forEach(({loadedAt}, recentPath) => {
        if (!isRecent(loadedAt)) {
            recentImages.delete(recentPath);
        }
    });
    recentImages.set(path, {
        imageUrl,
        loadedAt: Date.now(),
    });
    return imageUrl;
}

/**
 * An image file on the server's machine, by the absolute path in its `path` attribute, which the
 * browser can't load from a URL. Placed by tag name inside the HTML string that
 * `renderChatMarkdown` produces, so it takes no inputs. `alt` defaults to the path. Clicking it
 * emits `opened`, which bubbles out of the shadow roots it's placed in.
 */
export const VirAiChatLocalImage = defineAppElement()({
    tagName: 'vir-ai-chat-local-image',
    events: {
        opened: defineElementEvent<Readonly<MessageAttachment>>(),
    },
    styles: css`
        :host {
            display: inline-flex;
            max-width: 100%;
            vertical-align: top;
        }

        img {
            display: block;
            max-width: 100%;
            max-height: min(32rem, 70dvh);
            border-radius: 8px;
            cursor: zoom-in;
        }

        .message {
            color: ${viraThemeByKeys.grey.foreground.placeholder.foreground.value};
            font-size: 0.875em;
            overflow-wrap: anywhere;
        }
    `,
    state() {
        return {
            image: asyncProp({
                updateCallback: loadImageUrl,
            }),
        };
    },
    render({host, state, dispatch, events}) {
        const path = host.getAttribute('path') || '';
        const alt = host.getAttribute('alt') || '';
        const recent = recentImages.get(path);
        const recentUrl = recent && isRecent(recent.loadedAt) ? recent.imageUrl : undefined;
        if (!recentUrl) {
            state.image.update(path);
        }

        const imageUrl = recentUrl || (state.image.isResolved() ? state.image.value : undefined);

        function open() {
            const name = alt || path.slice(path.lastIndexOf('/') + 1);
            dispatch(
                new events.opened({
                    detail: {
                        path,
                        name,
                        tag: '',
                        isImage: true,
                        isPastedText: false,
                    },
                }),
            );
        }

        if (imageUrl) {
            return html`
                <img
                    src=${imageUrl}
                    alt=${alt || path}
                    role="button"
                    tabindex="0"
                    ${listen('click', open)}
                    ${listen('keydown', (event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            open();
                        }
                    })}
                />
            `;
        } else if (state.image.isError()) {
            return html`
                <span class="message">Couldn't show the image at ${path}.</span>
            `;
        } else {
            return html`
                <span class="message">Loading image…</span>
            `;
        }
    },
});
