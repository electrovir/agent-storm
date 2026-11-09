import {PaneStatus, type AiDefinition} from '@agent-storm/common';
import {css, html, nothing} from 'element-vir';
import {
    createSizedIcon,
    LucideHourglassIcon,
    LucideLoaderIcon,
    ViraIcon,
    viraThemeByKeys,
    type ViraIconSvg,
} from 'vira';
import {defineAppElement} from '../define-app-element.js';
import {spinAnimationCss, spinKeyframesCss} from './spin-styles.js';
import {VirAiAvatar} from './vir-ai-avatar.element.js';

const activityIndicators: Readonly<
    Record<
        PaneStatus,
        | Readonly<{
              icon: ViraIconSvg;
              title: string;
          }>
        | undefined
    >
> = {
    [PaneStatus.None]: undefined,
    [PaneStatus.Busy]: {
        icon: createSizedIcon(LucideLoaderIcon, 12),
        title: 'Working',
    },
    [PaneStatus.Stalled]: {
        icon: createSizedIcon(LucideHourglassIcon, 12),
        title: 'Unfinished work, but no sign of activity for a while. It may be stuck.',
    },
    [PaneStatus.Idle]: undefined,
    [PaneStatus.Exited]: undefined,
};

/**
 * A pane tab's label: its AI's avatar (or its kind's icon), its name, and what its session is
 * doing. It renders inside `ViraTabs`' shadow DOM, so it carries its own styles.
 */
export const VirPaneTabLabel = defineAppElement<{
    label: string;
    icon: ViraIconSvg;
    /** Shown instead of `icon`. */
    ai?: Readonly<AiDefinition> | undefined;
    /** When set, the label keeps room for the activity icon so tabs don't shift when it appears. */
    status?: PaneStatus | undefined;
}>()({
    tagName: 'vir-pane-tab-label',
    styles: css`
        :host {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            /*
             * ViraTabs turns off pointer events on the selected tab's link, which would keep the
             * selected tab's tooltip from ever opening. Clicking the selected tab still does
             * nothing: staticTabRouter cancels the link and ViraTabs skips selecting it again.
             */
            pointer-events: auto;
        }

        .activity {
            display: inline-flex;
            width: 12px;
            color: ${viraThemeByKeys.pink.foreground.header.foreground.value};
        }

        .activity[data-busy] ${ViraIcon} {
            ${spinAnimationCss}
        }

        .activity[data-stalled] {
            color: ${viraThemeByKeys.yellow.foreground.header.foreground.value};
        }

        ${spinKeyframesCss}
    `,
    render({inputs}) {
        const indicator = inputs.status ? activityIndicators[inputs.status] : undefined;
        return html`
            ${inputs.ai
                ? html`
                      <${VirAiAvatar.assign({
                          name: inputs.ai.name,
                          avatarFile: inputs.ai.avatarFile || '',
                          sizePx: 14,
                      })}></${VirAiAvatar}>
                  `
                : html`
                      <${ViraIcon.assign({
                          icon: inputs.icon,
                      })}></${ViraIcon}>
                  `}
            <span>${inputs.label}</span>
            ${inputs.status
                ? html`
                      <span
                          class="activity"
                          title=${indicator?.title || nothing}
                          ?data-busy=${inputs.status === PaneStatus.Busy}
                          ?data-stalled=${inputs.status === PaneStatus.Stalled}
                      >
                          ${indicator
                              ? html`
                                    <${ViraIcon.assign({
                                        icon: indicator.icon,
                                    })}></${ViraIcon}>
                                `
                              : nothing}
                      </span>
                  `
                : nothing}
        `;
    },
});
