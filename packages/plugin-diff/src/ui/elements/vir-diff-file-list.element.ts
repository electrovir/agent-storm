import {GitDiffSide, type GitDiffStatus} from '@agent-storm/common';
import {defineAppElement} from '@agent-storm/core/frontend';
import {css, html, listen, nothing, type HtmlInterpolation} from 'element-vir';
import {viraThemeByKeys} from 'vira';
import {diffMemory, diffSidebarWidth} from '../../util/diff-memory.js';
import {statusFilesKeys} from '../../util/diff-status.js';
import {VirDiffFileSection} from './vir-diff-file-section.element.js';

/**
 * Desktop file list, the SCM sidebar from VS Code: always visible next to the diff so switching
 * files is one click instead of opening a menu. Mobile keeps the dropdown, since a phone has no
 * width to give away. Sits at the pane's right edge behind its own resize divider.
 *
 * Its sections' events ({@link VirDiffFileSection}) bubble out of this element, so listen for them
 * here.
 */
export const VirDiffFileList = defineAppElement<{
    status: Readonly<GitDiffStatus> | undefined;
    selectedValue: string | undefined;
    markedValues: ReadonlyArray<string>;
    reviewSide: GitDiffSide | undefined;
    isBusy: boolean;
    /**
     * Sections the user collapsed. Owned by the pane rather than each section so the choice
     * survives a section emptying out and coming back.
     */
    collapsedSides: Readonly<Record<GitDiffSide, boolean>>;
    /** Shown above the sections. */
    header: HtmlInterpolation | undefined;
}>()({
    tagName: 'vir-diff-file-list',
    state() {
        return {
            sidebarWidth: diffMemory.sidebarWidth.read(),
            isDragging: false,
        };
    },
    styles: css`
        :host {
            display: flex;
            flex-grow: 0;
            flex-shrink: 0;
            min-height: 0;
        }

        .sidebar {
            display: flex;
            flex-direction: column;
            flex-grow: 0;
            flex-shrink: 0;
            min-height: 0;
            overflow: auto;
        }

        .sidebar-header-content {
            display: flex;
            flex-wrap: wrap;
            gap: 6px;
            padding: 8px;
            border-bottom: 1px solid
                ${viraThemeByKeys.grey['behind-bg'].decoration.background.value};
        }

        /* Same grab behavior as the CLI pane divider: 4px visible, ~14px of hit area. */
        .sidebar-divider {
            position: relative;
            flex-grow: 0;
            flex-shrink: 0;
            width: 4px;
            cursor: col-resize;
            background: ${viraThemeByKeys.grey['behind-bg'].decoration.background.value};
            transition: background 120ms ease;
            z-index: 1;
            touch-action: none;
        }

        .sidebar-divider::before {
            content: '';
            position: absolute;
            top: 0;
            bottom: 0;
            left: -5px;
            right: -5px;
        }

        .sidebar-divider:hover,
        .sidebar-divider[data-dragging] {
            background: ${viraThemeByKeys.grey.foreground.body.foreground.value};
        }
    `,
    render({inputs, state, updateState, host}) {
        /**
         * Resize, the same pointer-capture drag the CLI panes use. Width is measured from this
         * element's right edge, which is the pane's, since the list is anchored there.
         */
        function onDividerPointerDown(event: PointerEvent) {
            event.preventDefault();
            const divider = event.currentTarget;
            if (divider instanceof Element) {
                divider.setPointerCapture(event.pointerId);
            }

            const previousUserSelect = document.body.style.userSelect;
            const previousCursor = document.body.style.cursor;
            document.body.style.userSelect = 'none';
            document.body.style.cursor = 'col-resize';

            const latestWidth = {
                value: state.sidebarWidth,
            };
            updateState({
                isDragging: true,
            });

            function onMove(moveEvent: PointerEvent) {
                if (moveEvent.pointerId !== event.pointerId) {
                    return;
                }
                const rect = host.getBoundingClientRect();
                latestWidth.value = Math.min(
                    diffSidebarWidth.max,
                    Math.max(diffSidebarWidth.min, rect.right - moveEvent.clientX),
                );
                updateState({
                    sidebarWidth: latestWidth.value,
                });
            }

            function onUp(upEvent: PointerEvent) {
                if (upEvent.pointerId !== event.pointerId) {
                    return;
                }
                window.removeEventListener('pointermove', onMove);
                window.removeEventListener('pointerup', onUp);
                window.removeEventListener('pointercancel', onUp);
                document.body.style.userSelect = previousUserSelect;
                document.body.style.cursor = previousCursor;
                updateState({
                    isDragging: false,
                });
                diffMemory.sidebarWidth.write(latestWidth.value);
            }

            window.addEventListener('pointermove', onMove);
            window.addEventListener('pointerup', onUp);
            window.addEventListener('pointercancel', onUp);
        }

        /**
         * Each side gets its own fixed slot in the template even when it's empty, so a file moving
         * across the index can't make lit reuse the staged section's element as the unstaged one
         * and carry its collapsed state along with it.
         */
        function renderSection(side: GitDiffSide) {
            if (!inputs.status?.[statusFilesKeys[side]].length) {
                return nothing;
            }
            return html`
                <${VirDiffFileSection.assign({
                    side,
                    status: inputs.status,
                    selectedValue: inputs.selectedValue,
                    markedValues: inputs.markedValues,
                    reviewSide: inputs.reviewSide,
                    isBusy: inputs.isBusy,
                    isCollapsed: inputs.collapsedSides[side],
                })}></${VirDiffFileSection}>
            `;
        }

        return html`
            <div
                class="sidebar-divider"
                ?data-dragging=${state.isDragging}
                title="Drag to resize. Double-click to reset."
                ${listen('pointerdown', onDividerPointerDown)}
                ${listen('dblclick', () => {
                    updateState({
                        sidebarWidth: diffSidebarWidth.default,
                    });
                    diffMemory.sidebarWidth.write(diffSidebarWidth.default);
                })}
            ></div>
            <div
                class="sidebar"
                style=${css`
                    width: ${state.sidebarWidth}px;
                `}
            >
                ${inputs.header
                    ? html`
                          <div class="sidebar-header-content">${inputs.header}</div>
                      `
                    : nothing}
                ${renderSection(GitDiffSide.Staged)} ${renderSection(GitDiffSide.Unstaged)}
            </div>
        `;
    },
});
