// cspell:words pilcrow

import {DiffLayout, type GitDiffSide} from '@agent-storm/common';
import {defineAppElement} from '@agent-storm/core/frontend';
import {css, defineElementEvent, html, listen, nothing, type HtmlInterpolation} from 'element-vir';
import {
    LucideChevronDownIcon,
    LucideChevronLeftIcon,
    LucideChevronRightIcon,
    LucideChevronUpIcon,
    LucideColumns2Icon,
    LucideFoldVerticalIcon,
    LucidePilcrowIcon,
    LucideRows2Icon,
    LucideSparklesIcon,
    LucideTextWrapIcon,
    ViraButton,
    ViraColorVariant,
    ViraEmphasis,
    ViraSize,
    createSizedIcon,
    viraThemeByKeys,
} from 'vira';
import {type GitDiffStatus} from '../../diff-api.js';
import {allSelectValues} from '../../util/diff-status.js';
import {VirDiffFileMenu} from './vir-diff-file-menu.element.js';

/** Toolbar toggles read as settings rather than actions, so they sit a size below the nav arrows. */
const splitLayoutIcon = createSizedIcon(LucideColumns2Icon, 12);
const inlineLayoutIcon = createSizedIcon(LucideRows2Icon, 12);
const whitespaceIcon = createSizedIcon(LucidePilcrowIcon, 12);
const collapseUnchangedIcon = createSizedIcon(LucideFoldVerticalIcon, 12);
const softWrapIcon = createSizedIcon(LucideTextWrapIcon, 12);
const aiExplanationsIcon = createSizedIcon(LucideSparklesIcon, 12);

/** The diff pane's display choices, which the pane keeps in the server settings. */
export type DiffSettings = Readonly<{
    diffLayout: DiffLayout;
    hideWhitespace: boolean;
    collapseUnchanged: boolean;
    /** Undefined wraps everywhere but on a phone. */
    softWrap: boolean | undefined;
    hideAiExplanations: boolean;
}>;

/**
 * The diff pane's top bar: file and change navigation and the display toggles. On mobile it also
 * holds the file picker ({@link VirDiffFileMenu}), whose events bubble out of this element.
 */
export const VirDiffToolbar = defineAppElement<{
    isMobile: boolean;
    status: Readonly<GitDiffStatus> | undefined;
    selectedValue: string | undefined;
    reviewSide: GitDiffSide | undefined;
    /** Whether the open file's editor has any changes for the change arrows to move between. */
    hasChunks: boolean;
    /** Whether the diff currently shows inline, which `diffSettings.diffLayout` alone can't say. */
    unified: boolean;
    /** Whether long lines currently wrap, which `diffSettings.softWrap` alone can't say. */
    softWrap: boolean;
    diffSettings: DiffSettings;
    /** Undefined outside a manual review, which hides the AI explanations button. */
    aiExplanations?:
        | Readonly<{
              /** Whether the manual-review skill wrote any, without which the button is disabled. */
              hasAny: boolean;
          }>
        | undefined;
    /** Shown after the other buttons. */
    trailing?: HtmlInterpolation | undefined;
}>()({
    tagName: 'vir-diff-toolbar',
    events: {
        fileStep: defineElementEvent<number>(),
        chunkStep: defineElementEvent<number>(),
        settingsChange: defineElementEvent<Partial<DiffSettings>>(),
    },
    hostClasses: {
        'vir-diff-toolbar-mobile'({inputs}) {
            return inputs.isMobile;
        },
    },
    styles({hostClasses}) {
        return css`
            :host {
                display: flex;
                align-items: center;
                gap: 6px;
                flex-grow: 0;
                flex-shrink: 0;
                padding: 6px 8px;
                border-bottom: 1px solid
                    ${viraThemeByKeys.grey['behind-bg'].decoration.background.value};
            }

            /*
             * On mobile the picker claims the whole first row and the actions wrap below it, so the
             * file name gets full width and the buttons get touch-sized targets.
             */
            ${hostClasses['vir-diff-toolbar-mobile'].selector} {
                flex-wrap: wrap;
                gap: 8px;

                & .toolbar-actions {
                    flex-grow: 1;
                    justify-content: space-between;
                }
            }

            /*
             * The 100% basis is only here to force the wrap; the trigger inside still sizes to its
             * own contents, so the picker never stretches across an empty row.
             */
            ${VirDiffFileMenu} {
                flex-grow: 0;
                flex-shrink: 1;
                flex-basis: 100%;
            }

            .toolbar-trailing {
                display: flex;
                flex-grow: 1;
                justify-content: flex-end;
            }

            .toolbar-actions {
                display: flex;
                align-items: center;
                gap: 6px;
                flex-grow: 0;
                flex-shrink: 0;
            }

            .toolbar-group {
                display: flex;
                align-items: center;
                gap: 2px;
                flex-grow: 0;
                flex-shrink: 0;
            }
        `;
    },
    render({inputs, dispatch, events}) {
        const hasFiles = allSelectValues(inputs.status).length > 0;
        /** Touch targets need the room; a mouse pointer does not. */
        const buttonSize = inputs.isMobile ? ViraSize.Large : ViraSize.Small;

        function changeSettings(settings: Partial<DiffSettings>) {
            dispatch(
                new events.settingsChange({
                    detail: settings,
                }),
            );
        }

        const navigationTemplate = html`
            <div class="toolbar-group">
                <${ViraButton.assign({
                    icon: LucideChevronLeftIcon,
                    buttonSize,
                    buttonEmphasis: ViraEmphasis.Subtle,
                    color: ViraColorVariant.Plain,
                    isDisabled: !hasFiles,
                })}
                    title="Previous file"
                    ${listen('click', () => {
                        dispatch(
                            new events.fileStep({
                                detail: -1,
                            }),
                        );
                    })}
                ></${ViraButton}>
                <${ViraButton.assign({
                    icon: LucideChevronRightIcon,
                    buttonSize,
                    buttonEmphasis: ViraEmphasis.Subtle,
                    color: ViraColorVariant.Plain,
                    isDisabled: !hasFiles,
                })}
                    title="Next file"
                    ${listen('click', () => {
                        dispatch(
                            new events.fileStep({
                                detail: 1,
                            }),
                        );
                    })}
                ></${ViraButton}>
            </div>
            <div class="toolbar-group">
                <${ViraButton.assign({
                    icon: LucideChevronUpIcon,
                    buttonSize,
                    buttonEmphasis: ViraEmphasis.Subtle,
                    color: ViraColorVariant.Plain,
                    isDisabled: !inputs.hasChunks,
                })}
                    title="Previous change"
                    ${listen('click', () => {
                        dispatch(
                            new events.chunkStep({
                                detail: -1,
                            }),
                        );
                    })}
                ></${ViraButton}>
                <${ViraButton.assign({
                    icon: LucideChevronDownIcon,
                    buttonSize,
                    buttonEmphasis: ViraEmphasis.Subtle,
                    color: ViraColorVariant.Plain,
                    isDisabled: !inputs.hasChunks,
                })}
                    title="Next change"
                    ${listen('click', () => {
                        dispatch(
                            new events.chunkStep({
                                detail: 1,
                            }),
                        );
                    })}
                ></${ViraButton}>
            </div>
        `;

        const settingsTemplate = html`
            <${ViraButton.assign({
                icon: inputs.unified ? splitLayoutIcon : inlineLayoutIcon,
                buttonSize,
                buttonEmphasis: ViraEmphasis.Subtle,
                color: ViraColorVariant.Plain,
            })}
                title=${inputs.unified ? 'Switch to side-by-side' : 'Switch to inline'}
                ${listen('click', () => {
                    changeSettings({
                        diffLayout: inputs.unified ? DiffLayout.Split : DiffLayout.Inline,
                    });
                })}
            ></${ViraButton}>
            <${ViraButton.assign({
                icon: whitespaceIcon,
                buttonSize,
                buttonEmphasis: ViraEmphasis.Subtle,
                /** Lit up while whitespace changes are showing, since hiding them is the default. */
                color: inputs.diffSettings.hideWhitespace
                    ? ViraColorVariant.Plain
                    : ViraColorVariant.Info,
            })}
                title=${inputs.diffSettings.hideWhitespace
                    ? 'Whitespace-only changes are hidden. Click to show them.'
                    : 'Whitespace-only changes are shown. Click to hide them.'}
                ${listen('click', () => {
                    changeSettings({
                        hideWhitespace: !inputs.diffSettings.hideWhitespace,
                    });
                })}
            ></${ViraButton}>
            <${ViraButton.assign({
                icon: softWrapIcon,
                buttonSize,
                buttonEmphasis: ViraEmphasis.Subtle,
                /** Lit up while long lines wrap. */
                color: inputs.softWrap ? ViraColorVariant.Info : ViraColorVariant.Plain,
            })}
                title=${inputs.softWrap
                    ? 'Long lines wrap. Click to scroll them sideways instead.'
                    : 'Long lines scroll sideways. Click to wrap them.'}
                ${listen('click', () => {
                    changeSettings({
                        softWrap: !inputs.softWrap,
                    });
                })}
            ></${ViraButton}>
            <${ViraButton.assign({
                icon: collapseUnchangedIcon,
                buttonSize,
                buttonEmphasis: ViraEmphasis.Subtle,
                /** Lit up while every line is showing, matching the whitespace button. */
                color: inputs.diffSettings.collapseUnchanged
                    ? ViraColorVariant.Plain
                    : ViraColorVariant.Info,
            })}
                title=${inputs.diffSettings.collapseUnchanged
                    ? 'Unchanged lines are collapsed. Click to show the whole file.'
                    : 'The whole file is shown. Click to collapse unchanged lines.'}
                ${listen('click', () => {
                    changeSettings({
                        collapseUnchanged: !inputs.diffSettings.collapseUnchanged,
                    });
                })}
            ></${ViraButton}>
            ${inputs.aiExplanations
                ? renderAiExplanationsButton(inputs.aiExplanations.hasAny)
                : nothing}
        `;

        function renderAiExplanationsButton(hasAny: boolean) {
            const isShown = hasAny && !inputs.diffSettings.hideAiExplanations;
            return html`
                <${ViraButton.assign({
                    icon: aiExplanationsIcon,
                    buttonSize,
                    buttonEmphasis: ViraEmphasis.Subtle,
                    /** Lit up while the explanations are showing. */
                    color: isShown ? ViraColorVariant.Info : ViraColorVariant.Plain,
                    isDisabled: !hasAny,
                })}
                    title=${hasAny
                        ? isShown
                            ? 'AI explanations are shown beside each file. Click to hide them.'
                            : 'AI explanations are hidden. Click to show them beside each file.'
                        : 'The manual-review skill has not written AI explanations for this review.'}
                    ${listen('click', () => {
                        if (!hasAny) {
                            return;
                        }
                        changeSettings({
                            hideAiExplanations: !inputs.diffSettings.hideAiExplanations,
                        });
                    })}
                ></${ViraButton}>
            `;
        }

        return html`
            ${inputs.isMobile
                ? html`
                      <${VirDiffFileMenu.assign({
                          status: inputs.status,
                          selectedValue: inputs.selectedValue,
                          reviewSide: inputs.reviewSide,
                      })}></${VirDiffFileMenu}>
                  `
                : nothing}
            <div class="toolbar-actions">${navigationTemplate} ${settingsTemplate}</div>
            ${inputs.trailing
                ? html`
                      <div class="toolbar-trailing">${inputs.trailing}</div>
                  `
                : nothing}
        `;
    },
});
