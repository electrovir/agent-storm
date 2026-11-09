import {type GitDiffSide, type GitDiffStatus} from '@agent-storm/common';
import {defineAppElement} from '@agent-storm/core/frontend';
import {colorCss} from '@electrovir/color';
import {css, defineElementEvent, html, listen} from 'element-vir';
import {
    LucideChevronDownIcon,
    ViraIcon,
    ViraMenuItem,
    ViraMenuTrigger,
    createSizedIcon,
    viraThemeByKeys,
} from 'vira';
import {
    allSelectValues,
    findSelected,
    toMenuGroups,
    toSelectValue,
} from '../../util/diff-status.js';
import {toFileIconUrl} from '../../util/file-icon.js';
import {
    basename,
    changeBadgeColors,
    changeBadges,
    fileRowContents,
    fileRowStyles,
    reviewButtonTitle,
    reviewIcon,
    sideLabels,
} from './diff-file-row.js';

const caretIcon = createSizedIcon(LucideChevronDownIcon, 14);

/**
 * The diff pane's file picker on mobile, where there is no width for the file list: a trigger
 * naming the open file that drops down every changed file, grouped by side, each group led by its
 * stacked-review toggle.
 */
export const VirDiffFileMenu = defineAppElement<{
    status: Readonly<GitDiffStatus> | undefined;
    selectedValue: string | undefined;
    reviewSide: GitDiffSide | undefined;
}>()({
    tagName: 'vir-diff-file-menu',
    events: {
        fileSelect: defineElementEvent<string>(),
        reviewToggle: defineElementEvent<GitDiffSide>(),
    },
    styles: css`
        :host {
            display: flex;
            min-width: 0;
            max-width: 100%;
        }

        ${ViraMenuTrigger} {
            flex-grow: 0;
            flex-shrink: 1;
            min-width: 0;
            max-width: 100%;
        }

        .file-trigger {
            display: flex;
            align-items: center;
            gap: 8px;
            max-width: 100%;
            box-sizing: border-box;
            appearance: none;
            cursor: pointer;
            font: inherit;
            text-align: left;
            padding: 8px 10px;
            font-size: 15px;
            border-radius: 4px;
            border: 1px solid ${viraThemeByKeys.grey['behind-bg'].decoration.background.value};
            ${colorCss(viraThemeByKeys.grey.foreground.body)};
        }

        .file-trigger:hover:not(:disabled) {
            border-color: ${viraThemeByKeys.blue.foreground.body.foreground.value};
        }

        .file-trigger:disabled {
            cursor: default;
            color: ${viraThemeByKeys.grey.foreground.placeholder.foreground.value};
        }

        .trigger-name {
            flex-grow: 0;
            flex-shrink: 1;
            min-width: 0;
            overflow: hidden;
            white-space: nowrap;
            text-overflow: ellipsis;
            font-weight: 600;
        }

        .trigger-name.empty {
            font-weight: 400;
            color: ${viraThemeByKeys.grey.foreground.placeholder.foreground.value};
        }

        .trigger-caret {
            flex-grow: 0;
            flex-shrink: 0;
            color: ${viraThemeByKeys.grey.foreground['non-body'].foreground.value};
        }

        .menu-group-header {
            padding: 6px 12px 2px;
            font-size: 10px;
            letter-spacing: 0.06em;
            text-transform: uppercase;
            color: ${viraThemeByKeys.grey.foreground['non-body'].foreground.value};
        }

        .menu-row {
            display: flex;
            align-items: center;
            gap: 10px;
            min-width: 0;
            max-width: 60vw;
        }

        ${fileRowStyles}
    `,
    render({inputs, dispatch, events}) {
        const selected = findSelected(inputs.status, inputs.selectedValue);
        const hasFiles = allSelectValues(inputs.status).length > 0;

        const triggerTemplate = html`
            <button
                type="button"
                class="file-trigger"
                slot=${ViraMenuTrigger.slotNames['vira-menu-trigger-trigger']}
                title=${selected?.file.path || 'No changes'}
                ?disabled=${!hasFiles}
            >
                ${selected
                    ? html`
                          <img class="file-icon" src=${toFileIconUrl(selected.file.path)} alt="" />
                          <span class="trigger-name">${basename(selected.file.path)}</span>
                          <span
                              class="badge"
                              style=${css`
                                  color: ${changeBadgeColors[selected.file.change]};
                              `}
                          >
                              ${changeBadges[selected.file.change]}
                          </span>
                      `
                    : html`
                          <span class="trigger-name empty">
                              ${hasFiles ? 'Select a file' : 'No changes'}
                          </span>
                      `}
                <${ViraIcon.assign({
                    icon: caretIcon,
                })}
                    class="trigger-caret"
                ></${ViraIcon}>
            </button>
        `;

        const groupsTemplate = toMenuGroups(inputs.status).map((group) => {
            return html`
                <div class="menu-group-header">
                    ${sideLabels[group.side]} (${group.files.length})
                </div>
                <${ViraMenuItem.assign({
                    selected: inputs.reviewSide === group.side,
                })}
                    ${listen(ViraMenuItem.events.activate, () => {
                        dispatch(
                            new events.reviewToggle({
                                detail: group.side,
                            }),
                        );
                    })}
                >
                    <div
                        class="menu-row"
                        title=${reviewButtonTitle({
                            side: group.side,
                            reviewSide: inputs.reviewSide,
                        })}
                    >
                        <${ViraIcon.assign({
                            icon: reviewIcon,
                        })}></${ViraIcon}>
                        <span class="file-basename">Review all ${group.files.length}</span>
                    </div>
                </${ViraMenuItem}>
                ${group.files.map((file) => {
                    const value = toSelectValue(group.side, file.path);
                    return html`
                        <${ViraMenuItem.assign({
                            selected: value === inputs.selectedValue,
                        })}
                            ${listen(ViraMenuItem.events.activate, () => {
                                dispatch(
                                    new events.fileSelect({
                                        detail: value,
                                    }),
                                );
                            })}
                        >
                            <div class="menu-row" title=${file.path}>${fileRowContents(file)}</div>
                        </${ViraMenuItem}>
                    `;
                })}
            `;
        });

        return html`
            <${ViraMenuTrigger.assign({
                isDisabled: !hasFiles,
            })}>
                ${triggerTemplate} ${groupsTemplate}
            </${ViraMenuTrigger}>
        `;
    },
});
