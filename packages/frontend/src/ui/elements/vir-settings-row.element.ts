import {defineAppElement} from '@agent-storm/core/frontend';
import {type PartialWithUndefined} from '@augment-vir/common';
import {css, defineElementEvent, html, listen, nothing} from 'element-vir';
import {
    LucideRotateCcwIcon,
    ViraButton,
    ViraColorVariant,
    ViraEmphasis,
    ViraSize,
    viraThemeByKeys,
} from 'vira';

/**
 * The rounded, bordered box that groups settings rows. Shared as CSS because each settings section
 * renders its cards inside its own shadow root.
 */
export const settingsCardCss = css`
    .card {
        display: flex;
        flex-direction: column;
        border: 1px solid ${viraThemeByKeys.grey['behind-bg'].decoration.background.value};
        border-radius: 8px;

        & > * + * {
            border-top: 1px solid ${viraThemeByKeys.grey['behind-bg'].decoration.background.value};
        }
    }

    .card-title {
        font-size: 12px;
        font-weight: 600;
        color: ${viraThemeByKeys.grey.foreground['non-body'].foreground.value};
    }

    .card-hint {
        padding: 12px 16px;
        font-size: 12px;
        color: ${viraThemeByKeys.grey.foreground['non-body'].foreground.value};
    }
`;

/**
 * One setting in a settings card: its title and description on the left and its control, slotted
 * in, on the right. A modified setting shows a button that asks to reset it.
 */
export const VirSettingsRow = defineAppElement<
    {
        rowTitle: string;
    } & PartialWithUndefined<{
        description: string;
        isModified: boolean;
        errorMessage: string;
    }>
>()({
    tagName: 'vir-settings-row',
    events: {
        reset: defineElementEvent<void>(),
    },
    styles: css`
        :host {
            display: flex;
            flex-wrap: wrap;
            align-items: center;
            gap: 8px 16px;
            padding: 12px 16px;
        }

        .text {
            display: flex;
            flex-direction: column;
            flex-grow: 1;
            flex-basis: 220px;
            gap: 2px;
            min-width: 0;
        }

        .title {
            display: flex;
            align-items: center;
            gap: 4px;
            min-height: 24px;
            font-weight: 600;
        }

        .description {
            font-size: 12px;
            color: ${viraThemeByKeys.grey.foreground['non-body'].foreground.value};
        }

        .error {
            font-size: 12px;
            color: ${viraThemeByKeys.red.foreground.body.foreground.value};
        }

        .control {
            display: flex;
            flex-shrink: 0;
            align-items: center;
            justify-content: flex-end;
            gap: 8px;
            max-width: 100%;
        }
    `,
    render({inputs, dispatch, events}) {
        return html`
            <div class="text">
                <span class="title">
                    ${inputs.rowTitle}
                    ${inputs.isModified
                        ? html`
                              <span title="Reset to default">
                                  <${ViraButton.assign({
                                      icon: LucideRotateCcwIcon,
                                      buttonSize: ViraSize.Small,
                                      buttonEmphasis: ViraEmphasis.Subtle,
                                      color: ViraColorVariant.Neutral,
                                  })}
                                      ${listen('click', () => {
                                          dispatch(
                                              new events.reset({
                                                  detail: undefined,
                                              }),
                                          );
                                      })}
                                  ></${ViraButton}>
                              </span>
                          `
                        : nothing}
                </span>
                ${inputs.description
                    ? html`
                          <span class="description">${inputs.description}</span>
                      `
                    : nothing}
                ${inputs.errorMessage
                    ? html`
                          <span class="error">${inputs.errorMessage}</span>
                      `
                    : nothing}
            </div>
            <div class="control"><slot></slot></div>
        `;
    },
});
