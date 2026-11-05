import {css, html, listen} from 'element-vir';
import {AppModal, type AppContext} from '../../util/app-context.js';
import {defineAppElement} from '../define-app-element.js';
import {VirAiModal} from './vir-ai-modal.element.js';
import {VirAuthModal} from './vir-auth-modal.element.js';
import {VirSettingsModal} from './vir-settings-modal.element.js';

/** The app-wide modals. Settings and AI open through `context.openModal`; auth opens itself. */
export const VirAppModals = defineAppElement<{
    context: AppContext;
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
                open: inputs.context.openModal.value === AppModal.Settings,
            })}
                ${listen(VirSettingsModal.events.closeRequested, () => {
                    inputs.context.openModal.setValue(undefined);
                })}
                ${listen(VirSettingsModal.events.defineAiRequested, () => {
                    inputs.context.openModal.setValue(AppModal.Ai);
                })}
            ></${VirSettingsModal}>
            <${VirAiModal.assign({
                open: inputs.context.openModal.value === AppModal.Ai,
            })}
                ${listen(VirAiModal.events.closeRequested, () => {
                    inputs.context.openModal.setValue(undefined);
                })}
                ${listen(VirAiModal.events.configSaved, async () => {
                    await inputs.context.paneRestarts.bumpAiConfig();
                })}
            ></${VirAiModal}>
            <${VirAuthModal}></${VirAuthModal}>
        `;
    },
});
