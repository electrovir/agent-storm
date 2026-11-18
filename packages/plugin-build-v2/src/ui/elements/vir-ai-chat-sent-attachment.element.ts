import {defineAppElement} from '@agent-storm/core/frontend';
import {asyncProp, classMap, css, html} from 'element-vir';
import {tooltip} from 'vira';
import {buildV2Client} from '../../util/build-v2-client.js';
import {toImageThumbnailUrl} from '../../util/file-drop.js';
import {
    attachmentPreviewLength,
    attachmentThumbnailSize,
    type MessageAttachment,
} from '../../util/message-attachments.js';
import {attachmentCardStyles, renderAttachmentCardContent} from './attachment-card.js';

async function loadPreview({path, name, isImage, isPastedText}: Readonly<MessageAttachment>) {
    if (!isImage && !isPastedText) {
        return {
            imageUrl: undefined,
            textPreview: undefined,
        };
    }
    const {dataBase64} = await buildV2Client.call('readUpload', {
        path,
    });
    const blob = await (await fetch(`data:application/octet-stream;base64,${dataBase64}`)).blob();

    return isImage
        ? {
              imageUrl: await toImageThumbnailUrl({
                  file: new File(
                      [
                          blob,
                      ],
                      name,
                  ),
                  size: attachmentThumbnailSize,
              }),
              textPreview: undefined,
          }
        : {
              imageUrl: undefined,
              textPreview: (await blob.text()).slice(0, attachmentPreviewLength),
          };
}

/**
 * A file attached to a sent message, as the same card the composer showed. Shows only the name when
 * the upload can't be read back, such as after the OS clears its temp folder.
 */
export const VirAiChatSentAttachment = defineAppElement<{
    attachment: Readonly<MessageAttachment>;
}>()({
    tagName: 'vir-ai-chat-sent-attachment',
    state() {
        return {
            preview: asyncProp({
                updateCallback: loadPreview,
            }),
        };
    },
    styles: css`
        ${attachmentCardStyles}

        :host {
            display: flex;
        }
    `,
    render({inputs, state}) {
        state.preview.update(inputs.attachment);
        const preview = state.preview.isResolved() ? state.preview.value : undefined;

        return html`
            <div
                class=${classMap({
                    attachment: true,
                    image: !!preview?.imageUrl,
                })}
                ${tooltip(inputs.attachment.name)}
            >
                ${renderAttachmentCardContent({
                    name: inputs.attachment.name,
                    tag: inputs.attachment.tag,
                    imageUrl: preview?.imageUrl,
                    textPreview: preview?.textPreview,
                })}
            </div>
        `;
    },
});
