import {defineAppElement, sidebarTooltipOptions} from '@agent-storm/core/frontend';
import {css, defineElementEvent, html} from 'element-vir';
import {
    createSizedIcon,
    LucideEllipsisIcon,
    renderMenuItemEntries,
    tooltip,
    ViraButton,
    ViraColorVariant,
    ViraEmphasis,
    ViraMenuTrigger,
    ViraSize,
} from 'vira';
import {type ReviewedRepo} from '../../util/pr-reviews.js';

/** Same tap-target sizing as the Build sidebar's mobile header buttons. */
const mobileEllipsisIcon = createSizedIcon(LucideEllipsisIcon, 24);

/** The ellipsis menu that opens the init command settings for one repo or for the default. */
export const VirReviewSidebarSettingsMenu = defineAppElement<{
    menuTitle: string;
    /** Undefined opens the default every repo without its own command uses. */
    repo: Readonly<ReviewedRepo> | undefined;
    mobileModal?: boolean | undefined;
}>()({
    tagName: 'vir-review-sidebar-settings-menu',
    events: {
        settingsRequested: defineElementEvent<ReviewedRepo | undefined>(),
    },
    styles: css`
        :host {
            display: flex;
        }
    `,
    render({inputs, dispatch, events}) {
        return html`
            <${ViraMenuTrigger}>
                <${ViraButton.assign({
                    icon: inputs.mobileModal ? mobileEllipsisIcon : LucideEllipsisIcon,
                    buttonSize: inputs.mobileModal ? ViraSize.Large : ViraSize.Small,
                    buttonEmphasis: ViraEmphasis.Subtle,
                    color: ViraColorVariant.Neutral,
                })}
                    slot=${ViraMenuTrigger.slotNames['vira-menu-trigger-trigger']}
                    ${tooltip(inputs.menuTitle, sidebarTooltipOptions)}
                ></${ViraButton}>
                ${renderMenuItemEntries([
                    {
                        content: 'Settings',
                        onClick() {
                            dispatch(
                                new events.settingsRequested({
                                    detail: inputs.repo,
                                }),
                            );
                        },
                    },
                ])}
            </${ViraMenuTrigger}>
        `;
    },
});
