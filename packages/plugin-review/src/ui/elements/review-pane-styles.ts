// cspell:words meslo menlo

import {colorCss} from '@electrovir/color';
import {css} from 'element-vir';
import {viraThemeByKeys} from 'vira';

/** The avatar, name, and time line above a Review pane comment, review, or review request. */
export const commentHeaderStyles = css`
    .comment-header {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 11px;
        color: ${viraThemeByKeys.grey.foreground['non-body'].foreground.value};
    }

    .comment-author {
        font-weight: 600;
        color: ${viraThemeByKeys.grey.foreground.body.foreground.value};
    }

    .avatar {
        width: 18px;
        height: 18px;
        border-radius: 50%;
        flex-grow: 0;
        flex-shrink: 0;
    }
`;

/** A muted `.message` line, red when it has `data-error`. */
export const messageStyles = css`
    .message {
        color: ${viraThemeByKeys.grey.foreground.placeholder.foreground.value};
    }

    .message[data-error] {
        color: ${viraThemeByKeys.red.foreground.body.foreground.value};
    }
`;

/** Styles a `.markdown` container holding HTML that github.com rendered. */
export const markdownStyles = css`
    /* The element tree is whatever github.com emits, so these are element selectors. */
    .markdown {
        overflow-wrap: anywhere;
        font-size: 14px;

        & > *:first-child {
            margin-top: 0;
        }

        & > *:last-child {
            margin-bottom: 0;
        }

        & p,
        & ul,
        & ol,
        & blockquote,
        & table,
        & pre {
            margin: 6px 0;
        }

        & ul,
        & ol {
            padding-left: 20px;
        }

        & h1,
        & h2,
        & h3,
        & h4 {
            margin: 10px 0 4px;
            font-size: 14px;
        }

        & code {
            padding: 1px 4px;
            border-radius: 4px;
            font-family: 'MesloLGS NF', Menlo, monospace;
            font-size: 11px;
            ${colorCss(viraThemeByKeys.grey['behind-fg']['small-body'])};
        }

        & pre {
            padding: 8px;
            border-radius: 4px;
            overflow-x: auto;
            ${colorCss(viraThemeByKeys.grey['behind-fg']['small-body'])};
        }

        & pre code {
            padding: 0;
            background: none;
        }

        & blockquote {
            padding-left: 8px;
            border-left: 3px solid ${viraThemeByKeys.grey['behind-bg'].decoration.background.value};
            color: ${viraThemeByKeys.grey.foreground['non-body'].foreground.value};
        }

        & img {
            max-width: 100%;
        }

        & table {
            border-collapse: collapse;
        }

        & th,
        & td {
            padding: 2px 6px;
            border: 1px solid ${viraThemeByKeys.grey['behind-bg'].decoration.background.value};
        }

        & a {
            color: ${viraThemeByKeys.blue.foreground.body.foreground.value};
        }
    }
`;
