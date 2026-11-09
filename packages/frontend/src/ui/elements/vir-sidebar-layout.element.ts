import {
    defineAppElement,
    sidebarWidth,
    VirResizeDivider,
    type Setting,
} from '@agent-storm/core/frontend';
import {clamp} from '@augment-vir/common';
import {css, html, listen, nothing} from 'element-vir';

/**
 * A resizable sidebar slot beside a stage that takes the default slot, positioned so its children
 * can fill it absolutely. The sidebar isn't shown on mobile.
 */
export const VirSidebarLayout = defineAppElement<{
    /** Where the sidebar's width is stored. */
    widthSetting: Readonly<Setting<number>>;
    isMobile: boolean;
}>()({
    tagName: 'vir-sidebar-layout',
    slotNames: [
        'vir-sidebar-layout-sidebar',
    ],
    state() {
        return {
            width: sidebarWidth.default as number,
            dragStartWidth: sidebarWidth.default as number,
        };
    },
    init({inputs, updateState}) {
        updateState({
            width: inputs.widthSetting.read(),
        });
    },
    styles: css`
        :host {
            display: flex;
            flex-direction: row;
            min-width: 0;
            min-height: 0;
        }

        .sidebar::slotted(*) {
            width: var(--sidebar-layout-width);
            flex-shrink: 0;
        }

        .stage {
            position: relative;
            flex-grow: 1;
            min-width: 0;
            min-height: 0;
        }
    `,
    render({inputs, state, updateState, host, slotNames}) {
        host.style.setProperty('--sidebar-layout-width', `${state.width}px`);

        return html`
            ${inputs.isMobile
                ? nothing
                : html`
                      <slot class="sidebar" name=${slotNames['vir-sidebar-layout-sidebar']}></slot>
                      <${VirResizeDivider}
                          ${listen(VirResizeDivider.events.dragStarted, () => {
                              updateState({
                                  dragStartWidth: state.width,
                              });
                          })}
                          ${listen(VirResizeDivider.events.dragged, (event) => {
                              updateState({
                                  width: clamp(
                                      host.instanceState.dragStartWidth + event.detail.deltaX,
                                      sidebarWidth,
                                  ),
                              });
                          })}
                          ${listen(VirResizeDivider.events.dragEnded, () => {
                              inputs.widthSetting.write(host.instanceState.width);
                          })}
                          ${listen(VirResizeDivider.events.resetRequested, () => {
                              updateState({
                                  width: sidebarWidth.default,
                              });
                              inputs.widthSetting.write(sidebarWidth.default);
                          })}
                      ></${VirResizeDivider}>
                  `}
            <div class="stage"><slot></slot></div>
        `;
    },
});
