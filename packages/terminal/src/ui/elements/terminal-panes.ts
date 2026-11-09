import {PaneKind} from '@agent-storm/common';
import {
    findTabGroupId,
    isNewTabShortcut,
    PaneMounting,
    type PaneDefinition,
    type PaneRenderParams,
} from '@agent-storm/core/frontend';
import {html, listen} from 'element-vir';
import {createSizedIcon, LucideBotIcon, LucideSquareTerminalIcon} from 'vira';
import {VirTerminal} from './vir-terminal.element.js';

function renderTerminal(params: PaneRenderParams) {
    if (!params.sessionTab) {
        return '';
    }
    const sessionTab = params.sessionTab;
    return html`
        <${VirTerminal.assign({
            folder: params.folder,
            kind: sessionTab.kind,
            sessionId: sessionTab.session.id,
            active: params.isActive,
            showAccessoryKeys: params.isMobile,
            focusOnMount: params.sessionToFocus === sessionTab.session.id,
            isFocused: params.focusedTabId === params.tabId,
        })}
            ${listen('keydown', async (event) => {
                if (isNewTabShortcut(event)) {
                    event.preventDefault();
                    await params.openNewTab({
                        kind: params.kind,
                        groupId: findTabGroupId(params.layout, params.tabId),
                    });
                }
            })}
        ></${VirTerminal}>
    `;
}

/** A tab running one of the folder's AI sessions. */
export const aiPane: PaneDefinition = {
    id: PaneKind.Ai,
    label() {
        return 'AI';
    },
    newTabEntries() {
        return [
            {
                label: 'AI session',
                state: undefined,
            },
        ];
    },
    icon: createSizedIcon(LucideBotIcon, 14),
    hasAi: true,
    mounting: PaneMounting.WhileDisplayed,
    isAvailable() {
        return true;
    },
    render: renderTerminal,
};

/** A tab running one of the folder's shell sessions. */
export const shellPane: PaneDefinition = {
    id: PaneKind.Shell,
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
    hasAi: false,
    mounting: PaneMounting.WhileDisplayed,
    isAvailable() {
        return true;
    },
    render: renderTerminal,
};
