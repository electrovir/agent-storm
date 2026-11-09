import {type AppContext, defineAppElement, type SettingsTarget} from '@agent-storm/core/frontend';
import {css, html, type Observable} from 'element-vir';
import {VirAuthModal} from './vir-auth-modal.element.js';
import {VirOnboardingModal} from './vir-onboarding-modal.element.js';
import {VirSettingsModal} from './vir-settings-modal.element.js';

/**
 * The app-wide modals. Settings opens through `context.openSettings`; auth and first-run setup open
 * themselves.
 */
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
            <${VirOnboardingModal.assign({
                context: inputs.context,
            })}></${VirOnboardingModal}>
            <${VirAuthModal}></${VirAuthModal}>
        `;
    },
});
