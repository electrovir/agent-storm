import {css, html, nothing} from 'element-vir';
import {ViraSize, ViraTag, viraThemeByKeys} from 'vira';

/**
 * Styles for a `.attachment` card holding `renderAttachmentCardContent`'s output. Add an `image`
 * class to the card when it shows an image.
 */
export const attachmentCardStyles = css`
    .attachment {
        position: relative;
        display: flex;
        flex-shrink: 0;
        flex-direction: column;
        justify-content: space-between;
        align-items: flex-start;
        gap: 6px;
        box-sizing: border-box;
        width: 112px;
        height: 112px;
        padding: 8px;
        border-radius: 10px;
        border: 1px solid ${viraThemeByKeys.grey.foreground.decoration.foreground.value};
        background-color: ${viraThemeByKeys.grey['behind-fg']['small-body'].background.value};
        overflow: hidden;
        font-size: 12px;

        &.image {
            padding: 0;
        }

        & img {
            width: 100%;
            height: 100%;
            object-fit: cover;
        }

        & .name {
            display: -webkit-box;
            -webkit-box-orient: vertical;
            -webkit-line-clamp: 3;
            overflow: hidden;
            overflow-wrap: anywhere;
            font-weight: bold;
        }

        & .preview {
            flex-grow: 1;
            min-height: 0;
            overflow: hidden;
            white-space: pre-wrap;
            overflow-wrap: anywhere;
            font-size: 10px;
            color: ${viraThemeByKeys.grey.foreground.placeholder.foreground.value};
            mask-image: linear-gradient(to bottom, black 60%, transparent);
        }
    }
`;

/** An image thumbnail when there's an `imageUrl`, else the text preview or name and the tag. */
export function renderAttachmentCardContent({
    name,
    tag,
    imageUrl,
    textPreview,
}: Readonly<{
    name: string;
    /** Empty for none. */
    tag: string;
    imageUrl: string | undefined;
    textPreview: string | undefined;
}>) {
    if (imageUrl) {
        return html`
            <img src=${imageUrl} alt=${name} />
        `;
    }
    return html`
        ${textPreview == undefined
            ? html`
                  <span class="name">${name}</span>
              `
            : html`
                  <span class="preview">${textPreview}</span>
              `}
        ${tag
            ? html`
                  <${ViraTag.assign({
                      text: tag,
                      size: ViraSize.Small,
                  })}></${ViraTag}>
              `
            : nothing}
    `;
}
