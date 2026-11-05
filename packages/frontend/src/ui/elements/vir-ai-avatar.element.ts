import {css, html} from 'element-vir';
import {viraThemeByKeys} from 'vira';
import {getCachedAvatarUrl, loadAvatarUrl} from '../../util/ai-avatar.js';
import {defineAppElement} from '../define-app-element.js';

/**
 * One AI's avatar at whatever size the caller needs, falling back to the first letter of its name.
 * Owns its own fetch: avatars come back through the API rather than an image URL, so each place
 * that shows one would otherwise repeat the same load-and-cache dance.
 */
export const VirAiAvatar = defineAppElement<{
    name: string;
    /** Empty renders the initial-letter fallback, which is also what a deleted image falls back to. */
    avatarFile: string;
    sizePx: number;
}>()({
    tagName: 'vir-ai-avatar',
    state() {
        return {
            /** Bumped when a fetch resolves, purely to trigger a re-render off the shared cache. */
            loadedCount: 0,
            requestedFile: undefined as string | undefined,
        };
    },
    styles: css`
        :host {
            display: inline-flex;
            flex-shrink: 0;
        }

        .avatar {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            box-sizing: border-box;
            overflow: hidden;
            border-radius: 50%;
            object-fit: cover;
            font-weight: 600;
            text-transform: uppercase;
            background: ${viraThemeByKeys.grey['behind-fg']['small-body'].background.value};
            color: ${viraThemeByKeys.grey.foreground['non-body'].foreground.value};
        }

        img.avatar {
            background: transparent;
        }
    `,
    render({inputs, state, updateState}) {
        const cachedUrl = inputs.avatarFile ? getCachedAvatarUrl(inputs.avatarFile) : undefined;
        if (inputs.avatarFile && !cachedUrl && state.requestedFile !== inputs.avatarFile) {
            updateState({
                requestedFile: inputs.avatarFile,
            });
            void loadAvatarUrl(inputs.avatarFile).then(() => {
                updateState({
                    loadedCount: state.loadedCount + 1,
                });
            });
        }
        const sizeStyle = css`
            width: ${inputs.sizePx}px;
            height: ${inputs.sizePx}px;
            /* Keep the fallback letter proportional to the circle at every size it's used at. */
            font-size: ${Math.max(7, Math.round(inputs.sizePx * 0.55))}px;
        `;

        return cachedUrl
            ? html`
                  <img class="avatar" style=${sizeStyle} src=${cachedUrl} alt=${inputs.name} />
              `
            : html`
                  <span class="avatar" style=${sizeStyle} title=${inputs.name}>
                      ${inputs.name.trim().slice(0, 1)}
                  </span>
              `;
    },
});
