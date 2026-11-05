import {check} from '@augment-vir/assert';
import {getObjectTypedValues} from '@augment-vir/common';
import {css, defineElementEvent, html, listen, nothing} from 'element-vir';
import {noUserSelect, ViraDropdown, ViraIcon, viraThemeByKeys} from 'vira';
import {type FrontendTab} from '../../util/frontend-tab.js';
import {DiffView, type PaneTabButton} from '../../util/pane-layout.js';
import {defineAppElement} from '../define-app-element.js';

const diffViewLabels: Readonly<Record<DiffView, string>> = {
    [DiffView.Source]: 'Source',
    [DiffView.ManualReview]: 'Manual review',
};

/** A pane group's tab bar, under the folder's name on mobile. */
export const VirPaneHeader = defineAppElement<{
    folder: string;
    isMobile: boolean;
    tabButtons: ReadonlyArray<Readonly<PaneTabButton>>;
    /** Shows the picker for which checkout the Diff tab shows. */
    diffViewPicker?:
        | Readonly<{
              selected: DiffView;
              isSelectable: Readonly<Record<DiffView, boolean>>;
          }>
        | undefined;
}>()({
    tagName: 'vir-pane-header',
    events: {
        /** The parent should show this tab, keeping the route's paths. */
        tabRequested: defineElementEvent<FrontendTab>(),
        diffViewSelected: defineElementEvent<DiffView>(),
    },
    styles: css`
        :host {
            display: flex;
            flex-direction: column;
            flex-shrink: 0;
        }

        /*
         * Mobile-only strip naming the active folder. Sits above the tab bar and has to fully
         * contain vir-mobile-sidebar's absolutely-positioned hamburger (6px inset on a 24px
         * button), so the tab bar below it stays clear of the hamburger and needs no left padding
         * of its own. 32px is that button's extent and nothing more — this strip is pure overhead
         * on a phone screen. The symmetric horizontal padding keeps the name centered while
         * clearing the hamburger.
         */
        .folder-name-bar {
            display: flex;
            align-items: center;
            justify-content: center;
            box-sizing: border-box;
            min-height: 32px;
            padding: 0 34px;
            border-bottom: 1px solid
                ${viraThemeByKeys.grey['behind-bg'].decoration.background.value};
        }

        .folder-name-label {
            min-width: 0;
            overflow: hidden;
            white-space: nowrap;
            text-overflow: ellipsis;
            font-size: 12px;
            font-weight: 600;
            color: ${viraThemeByKeys.grey.foreground.body.foreground.value};
        }

        .tab-bar {
            display: flex;
            border-bottom: 1px solid
                ${viraThemeByKeys.grey['behind-bg'].decoration.background.value};
            font-size: 12px;
        }

        .tab {
            ${noUserSelect};
            display: inline-flex;
            align-items: center;
            gap: 6px;
            appearance: none;
            background: transparent;
            border: none;
            border-bottom: 2px solid transparent;
            padding: 6px 14px;
            cursor: pointer;
            color: ${viraThemeByKeys.grey.foreground['non-body'].foreground.value};
            font: inherit;
            letter-spacing: 0.02em;
            transition:
                color 120ms ease,
                border-bottom-color 120ms ease;
        }

        .tab:hover {
            color: ${viraThemeByKeys.grey.foreground.body.foreground.value};
        }

        .tab[data-selected] {
            color: ${viraThemeByKeys.blue.foreground.body.foreground.value};
            border-bottom-color: ${viraThemeByKeys.blue.foreground.body.foreground.value};
        }

        .diff-view-picker {
            display: flex;
            flex-grow: 1;
            justify-content: flex-end;
            align-items: center;
            gap: 6px;
            padding: 2px 6px;
        }
    `,
    render({inputs, dispatch, events}) {
        const diffViewPicker = inputs.diffViewPicker;

        return html`
            ${inputs.isMobile
                ? html`
                      <div class="folder-name-bar" title=${inputs.folder}>
                          <span class="folder-name-label">
                              ${inputs.folder.split('/').findLast(Boolean) || inputs.folder}
                          </span>
                      </div>
                  `
                : nothing}
            ${inputs.tabButtons.length
                ? html`
                      <div class="tab-bar" role="tablist">
                          ${inputs.tabButtons.map(({label, icon, tab, isActive}) => {
                              return html`
                                  <button
                                      type="button"
                                      class="tab"
                                      role="tab"
                                      ?data-selected=${isActive}
                                      aria-selected=${isActive}
                                      ${listen('click', () => {
                                          dispatch(
                                              new events.tabRequested({
                                                  detail: tab,
                                              }),
                                          );
                                      })}
                                  >
                                      ${icon
                                          ? html`
                                                <${ViraIcon.assign({
                                                    icon,
                                                })}></${ViraIcon}>
                                            `
                                          : nothing}
                                      ${label}
                                  </button>
                              `;
                          })}
                          ${diffViewPicker
                              ? html`
                                    <div class="diff-view-picker">
                                        <${ViraDropdown.assign({
                                            options: getObjectTypedValues(DiffView).map((view) => {
                                                return {
                                                    value: view,
                                                    label: diffViewLabels[view],
                                                    disabled: !diffViewPicker.isSelectable[view],
                                                };
                                            }),
                                            selected: [
                                                diffViewPicker.selected,
                                            ],
                                        })}
                                            ${listen(
                                                ViraDropdown.events.selectedValuesChange,
                                                (event) => {
                                                    const view = event.detail[0];
                                                    if (check.isEnumValue(view, DiffView)) {
                                                        dispatch(
                                                            new events.diffViewSelected({
                                                                detail: view,
                                                            }),
                                                        );
                                                    }
                                                },
                                            )}
                                        ></${ViraDropdown}>
                                    </div>
                                `
                              : nothing}
                      </div>
                  `
                : nothing}
        `;
    },
});
