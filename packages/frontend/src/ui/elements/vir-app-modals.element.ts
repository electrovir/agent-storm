import {type AppContext, defineAppElement, type SettingsTarget} from '@agent-storm/core/frontend';
import {css, html, type Observable} from 'element-vir';
import {VirAuthModal} from './vir-auth-modal.element.js';
import {VirSettingsModal} from './vir-settings-modal.element.js';

/** The app-wide modals. Settings opens through `context.openSettings`; auth opens itself. */
export const VirAppModals = defineAppElement<{
    context: AppContext;
    /** Where the Settings modal is, or was last left in this window. */
    settingsTarget: Observable<SettingsTarget>;
    isSettingsOpen: Observable<boolean>;
}>()({
    tagName: 'vir-app-modals',
    styles: css`
        :host {
            display: contents;
        }
    `,
    render({inputs}) {
        return html`
            <${VirSettingsModal.assign({
                context: inputs.context,
                settingsTarget: inputs.settingsTarget,
                isSettingsOpen: inputs.isSettingsOpen,
            })}></${VirSettingsModal}>
            <${VirAuthModal}></${VirAuthModal}>
        `;
    },
});
