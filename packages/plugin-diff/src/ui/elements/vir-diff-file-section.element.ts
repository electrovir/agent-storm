// cspell:words unstaging

import {GitDiffSide, type GitDiffStatus} from '@agent-storm/common';
import {defineAppElement} from '@agent-storm/core/frontend';
import {check} from '@augment-vir/assert';
import {colorCss} from '@electrovir/color';
import {css, defineElementEvent, html, listen, type HtmlInterpolation} from 'element-vir';
import {
    LucideMinusIcon,
    LucidePlusIcon,
    LucideUndo2Icon,
    ViraCollapsibleCard,
    ViraIcon,
    createSizedIcon,
    viraThemeByKeys,
    type ViraIconSvg,
} from 'vira';
import {
    canDiscardSide,
    findSelected,
    statusFilesKeys,
    toSelectValue,
    type SelectedFile,
} from '../../util/diff-status.js';
import {
    fileRowContents,
    fileRowStyles,
    reviewButtonTitle,
    reviewIcon,
    sideLabels,
} from './diff-file-row.js';
import {stageActionLabels} from './vir-diff-review-file.element.js';

const revertIcon = createSizedIcon(LucideUndo2Icon, 14);

/** Direction the row's stage button moves the file, matching {@link stageActionLabels}. */
const stageActionIcons: Readonly<Record<GitDiffSide, ViraIconSvg>> = {
    [GitDiffSide.Staged]: createSizedIcon(LucideMinusIcon, 14),
    [GitDiffSide.Unstaged]: createSizedIcon(LucidePlusIcon, 14),
};

/**
 * One side's collapsible group in the diff pane's file list: the side's bulk buttons in its header,
 * then a row per file with its own discard and stage buttons. It only reports clicks; the pane does
 * the git writes.
 */
export const VirDiffFileSection = defineAppElement<{
    side: GitDiffSide;
    status: Readonly<GitDiffStatus> | undefined;
    selectedValue: string | undefined;
    markedValues: ReadonlyArray<string>;
    reviewSide: GitDiffSide | undefined;
    isBusy: boolean;
    /** Only read when the section mounts, since that is when its collapsible is built. */
    isCollapsed: boolean;
}>()({
    tagName: 'vir-diff-file-section',
    events: {
        /** A file name was clicked: `isRange` for a shift click, `isToggle` for cmd or ctrl. */
        rowClick: defineElementEvent<
            Readonly<{
                value: string;
                isRange: boolean;
                isToggle: boolean;
            }>
        >(),
        filesStage: defineElementEvent<ReadonlyArray<SelectedFile>>(),
        filesDiscard: defineElementEvent<ReadonlyArray<SelectedFile>>(),
        sideStage: defineElementEvent<GitDiffSide>(),
        unstagedDiscard: defineElementEvent<undefined>(),
        reviewToggle: defineElementEvent<GitDiffSide>(),
        collapseChange: defineElementEvent<
            Readonly<{
                side: GitDiffSide;
                isCollapsed: boolean;
            }>
        >(),
    },
    styles: css`
        :host {
            display: flex;
            flex-direction: column;
            flex-grow: 0;
            flex-shrink: 0;
        }

        ${ViraCollapsibleCard} {
            display: flex;
            flex-grow: 0;
            flex-shrink: 0;
            ${ViraCollapsibleCard.cssVars['vira-collapsible-card-content-gap'].name}: 0;
        }

        .sidebar-header {
            display: flex;
            align-items: center;
            gap: 4px;
            flex-grow: 1;
            padding: 6px 8px 2px;
            font-size: 10px;
            letter-spacing: 0.06em;
            text-transform: uppercase;
            color: ${viraThemeByKeys.grey.foreground['non-body'].foreground.value};
        }

        .sidebar-header-label {
            flex-grow: 1;
            min-width: 0;
        }

        /*
         * Always visible, unlike the per-row actions: a section header has no row to hover, and
         * these are the buttons most worth reaching for without hunting.
         */
        .header-actions {
            display: flex;
            align-items: center;
            flex-grow: 0;
            flex-shrink: 0;
            gap: 2px;
        }

        .sidebar-row {
            display: flex;
            align-items: center;
            width: 100%;
            box-sizing: border-box;
        }

        .sidebar-row:hover {
            background-color: ${viraThemeByKeys.grey['behind-bg'].invisible.background.value};
        }

        /*
         * Marked rows read as a group without competing with the open file, which keeps its
         * stronger blue. Declared first so the open file wins when it is also marked.
         */
        .sidebar-row[data-marked] {
            background-color: ${viraThemeByKeys.blue['behind-bg'].invisible.background.value};
        }

        .sidebar-row[data-selected] {
            background-color: ${viraThemeByKeys.blue['behind-bg'].decoration.background.value};
        }

        /* Marking files is pointless if the buttons that act on them need a hover to appear. */
        .sidebar-row[data-marked] .row-actions {
            visibility: visible;
        }

        .sidebar-row-open {
            display: flex;
            align-items: center;
            gap: 8px;
            flex-grow: 1;
            min-width: 0;
            padding: 3px 8px;
            appearance: none;
            border: none;
            background: none;
            cursor: pointer;
            font: inherit;
            text-align: left;
            color: inherit;
        }

        /*
         * Hidden by visibility rather than display so the row's width doesn't shift when the
         * pointer arrives — the file name would otherwise reflow under the cursor mid-click.
         */
        .row-actions {
            display: flex;
            align-items: center;
            flex-grow: 0;
            flex-shrink: 0;
            gap: 2px;
            padding-right: 4px;
            visibility: hidden;
        }

        .sidebar-row:hover .row-actions,
        .row-actions:focus-within {
            visibility: visible;
        }

        /*
         * A touch screen has no hover to reveal them with, so hiding them would put staging and
         * discarding out of reach entirely. Keyed on the pointer rather than on viewport width: a
         * narrow desktop window still has a mouse, and a tablet at desktop width still does not.
         */
        @media (hover: none) {
            .row-actions {
                visibility: visible;
            }
        }

        .row-action {
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 2px;
            appearance: none;
            border: none;
            border-radius: 3px;
            background: none;
            cursor: pointer;
            color: ${viraThemeByKeys.grey.foreground['non-body'].foreground.value};
        }

        .row-action:hover:not(:disabled) {
            ${colorCss(viraThemeByKeys.grey.foreground.body)};
        }

        .row-action:disabled {
            cursor: default;
            opacity: 0.4;
        }

        /* Lit up while its side's review is the thing on screen. */
        .row-action[data-active] {
            color: ${viraThemeByKeys.blue.foreground.body.foreground.value};
        }

        /*
         * Staged files have nothing to discard — unstaging is the only move — but the button keeps
         * its space so the stage buttons line up down the whole list.
         */
        .row-action[data-hidden] {
            visibility: hidden;
        }

        ${fileRowStyles}
    `,
    render({inputs, dispatch, events}) {
        const files = inputs.status?.[statusFilesKeys[inputs.side]] ?? [];

        /**
         * Files a row's action button applies to: the whole marked set when that row is part of it,
         * and otherwise just that row. Clicking a button on an unmarked row is how the user acts on
         * one file without having to clear the marks first.
         */
        function actionTargets(value: string) {
            return (inputs.markedValues.includes(value) ? inputs.markedValues : [value])
                .map((target) => findSelected(inputs.status, target))
                .filter(check.isTruthy);
        }

        /**
         * Bulk buttons in the header. `stopPropagation` keeps the click from reaching the
         * collapsible's header, which would otherwise fold the section the button just emptied. The
         * staged side gets no discard-all: unstaging is the way back out of the index, and it loses
         * nothing, so the only bulk discard is the unstaged side's.
         */
        const sideHeaderActions: Readonly<Record<GitDiffSide, () => HtmlInterpolation>> = {
            [GitDiffSide.Unstaged]() {
                return html`
                    <button
                        type="button"
                        class="row-action"
                        title="Discard all unstaged changes"
                        ?disabled=${inputs.isBusy}
                        ${listen('click', (event) => {
                            event.stopPropagation();
                            dispatch(
                                new events.unstagedDiscard({
                                    detail: undefined,
                                }),
                            );
                        })}
                    >
                        <${ViraIcon.assign({
                            icon: revertIcon,
                        })}></${ViraIcon}>
                    </button>
                    <button
                        type="button"
                        class="row-action"
                        title="Stage all changes"
                        ?disabled=${inputs.isBusy}
                        ${listen('click', (event) => {
                            event.stopPropagation();
                            dispatch(
                                new events.sideStage({
                                    detail: GitDiffSide.Unstaged,
                                }),
                            );
                        })}
                    >
                        <${ViraIcon.assign({
                            icon: stageActionIcons[GitDiffSide.Unstaged],
                        })}></${ViraIcon}>
                    </button>
                `;
            },
            [GitDiffSide.Staged]() {
                return html`
                    <button
                        type="button"
                        class="row-action"
                        title="Unstage all changes"
                        ?disabled=${inputs.isBusy}
                        ${listen('click', (event) => {
                            event.stopPropagation();
                            dispatch(
                                new events.sideStage({
                                    detail: GitDiffSide.Staged,
                                }),
                            );
                        })}
                    >
                        <${ViraIcon.assign({
                            icon: stageActionIcons[GitDiffSide.Staged],
                        })}></${ViraIcon}>
                    </button>
                `;
            },
        };

        const rowsTemplate = files.map((file) => {
            const value = toSelectValue(inputs.side, file.path);
            const rowTargets = actionTargets(value);
            return html`
                <div
                    class="sidebar-row"
                    ?data-selected=${value === inputs.selectedValue}
                    ?data-marked=${inputs.markedValues.includes(value)}
                >
                    <button
                        type="button"
                        class="sidebar-row-open"
                        title=${file.path}
                        ${listen('click', (event) => {
                            dispatch(
                                new events.rowClick({
                                    detail: {
                                        value,
                                        isRange: event.shiftKey,
                                        isToggle: event.metaKey || event.ctrlKey,
                                    },
                                }),
                            );
                        })}
                    >
                        ${fileRowContents(file)}
                    </button>
                    <div class="row-actions">
                        <button
                            type="button"
                            class="row-action"
                            title=${rowTargets.length > 1
                                ? `Discard all changes to the ${rowTargets.length} selected files`
                                : 'Discard all changes to this file'}
                            ?data-hidden=${!canDiscardSide[inputs.side]}
                            ?disabled=${inputs.isBusy || !canDiscardSide[inputs.side]}
                            ${listen('click', () => {
                                dispatch(
                                    new events.filesDiscard({
                                        detail: rowTargets,
                                    }),
                                );
                            })}
                        >
                            <${ViraIcon.assign({
                                icon: revertIcon,
                            })}></${ViraIcon}>
                        </button>
                        <button
                            type="button"
                            class="row-action"
                            title=${rowTargets.length > 1
                                ? `${stageActionLabels[inputs.side]} the ${rowTargets.length} selected files`
                                : stageActionLabels[inputs.side]}
                            ${listen('click', () => {
                                dispatch(
                                    new events.filesStage({
                                        detail: rowTargets,
                                    }),
                                );
                            })}
                        >
                            <${ViraIcon.assign({
                                icon: stageActionIcons[inputs.side],
                            })}></${ViraIcon}>
                        </button>
                    </div>
                </div>
            `;
        });

        return html`
            <${ViraCollapsibleCard.assign({
                rawCollapsible: true,
                startExpanded: !inputs.isCollapsed,
            })}
                ${listen(ViraCollapsibleCard.events.expandToggle, (event) => {
                    dispatch(
                        new events.collapseChange({
                            detail: {
                                side: inputs.side,
                                isCollapsed: !event.detail,
                            },
                        }),
                    );
                })}
            >
                <div
                    class="sidebar-header"
                    slot=${ViraCollapsibleCard.slotNames['vira-collapsible-card-header']}
                >
                    <span class="sidebar-header-label">
                        ${sideLabels[inputs.side]} (${files.length})
                    </span>
                    <div class="header-actions">
                        <button
                            type="button"
                            class="row-action"
                            ?data-active=${inputs.reviewSide === inputs.side}
                            title=${reviewButtonTitle({
                                side: inputs.side,
                                reviewSide: inputs.reviewSide,
                            })}
                            ${listen('click', (event) => {
                                event.stopPropagation();
                                dispatch(
                                    new events.reviewToggle({
                                        detail: inputs.side,
                                    }),
                                );
                            })}
                        >
                            <${ViraIcon.assign({
                                icon: reviewIcon,
                            })}></${ViraIcon}>
                        </button>
                        ${sideHeaderActions[inputs.side]()}
                    </div>
                </div>
                ${rowsTemplate}
            </${ViraCollapsibleCard}>
        `;
    },
});
