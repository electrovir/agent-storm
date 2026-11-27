import {PaneKind} from '@agent-storm/common';
import {
    findTabGroupId,
    isNewTabShortcut,
    noTabStateShape,
    PaneMounting,
    type PaneDefinition,
    type PaneRenderParams,
} from '@agent-storm/core/frontend';
import {html, listen} from 'element-vir';
import {createSizedIcon, LucideSquareTerminalIcon} from 'vira';
import {VirTerminal} from './vir-terminal.element.js';

function renderTerminal({
    sessionTab,
    folder,
    isActive,
    isMobile,
    sessionToFocus,
    focusedTabId,
    tabId,
    openNewTab,
    kind,
    layout,
}: PaneRenderParams) {
    if (!sessionTab) {
        return '';
    }
    return html`
        <${VirTerminal.assign({
            folder,
            kind: sessionTab.kind,
            sessionId: sessionTab.session.id,
            active: isActive,
            showAccessoryKeys: isMobile,
            focusOnMount: sessionToFocus === sessionTab.session.id,
            isFocused: focusedTabId === tabId,
        })}
            ${listen('keydown', async (event) => {
                if (isNewTabShortcut(event)) {
                    event.preventDefault();
                    await openNewTab({
                        kind,
                        groupId: findTabGroupId(layout, tabId),
                    });
                }
            })}
        ></${VirTerminal}>
    `;
}

/** A tab running one of the folder's shell sessions. */
export const shellPane: PaneDefinition = {
    id: PaneKind.Shell,
    tabStateShape: noTabStateShape,
    label() {
        return 'Shell';
    },
    newTabEntries() {
        return [
            {
                label: 'Shell',
                state: undefined,
            },
        ];
    },
    icon: createSizedIcon(LucideSquareTerminalIcon, 14),
    mounting: PaneMounting.WhileDisplayed,
    isAvailable() {
        return true;
    },
    render: renderTerminal,
};
