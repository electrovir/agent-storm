import {css} from 'element-vir';
import {viraThemeByKeys} from 'vira';

/** Shared by the Bots tab's repo and bot views, for their `.view` part. */
export const botViewStyles = css`
    .view {
        display: flex;
        flex-direction: column;
        gap: 12px;
        padding: 12px 16px;
        font-size: 13px;
    }

    h2,
    h3 {
        margin: 0;
    }

    h2 {
        font-size: 16px;
    }

    h3 {
        font-size: 14px;
    }

    .header,
    .actions {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 8px;
    }

    .faint {
        color: ${viraThemeByKeys.grey.foreground.placeholder.foreground.value};
    }

    .error {
        color: ${viraThemeByKeys.red.foreground.body.foreground.value};
        overflow-wrap: anywhere;
        white-space: pre-wrap;
    }

    pre {
        margin: 0;
        padding: 8px;
        overflow: auto;
        max-height: 400px;
        background-color: ${viraThemeByKeys.grey['behind-fg']['small-body'].background.value};
    }
`;
