import {css} from 'element-vir';
import {ViraButton, ViraInput} from 'vira';

/** Layout shared by the sidebar's add-repo and add-worktree modals. */
export const sidebarFormModalStyles = css`
    .body {
        display: flex;
        flex-direction: column;
        gap: 12px;
        width: min(520px, calc(100dvw - 48px));
        max-width: 100%;
        box-sizing: border-box;

        & ${ViraInput} {
            min-width: 0;
            width: 100%;
        }
    }

    .footer {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
    }

    @media (max-width: 420px) {
        .body {
            width: calc(100dvw - 32px);
        }

        .footer {
            justify-content: stretch;

            & ${ViraButton} {
                width: 100%;
            }
        }
    }
`;
