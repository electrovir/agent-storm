import {css, html} from 'element-vir';
import {type AppContext} from '../../util/app-context.js';
import {defineAppElement} from '../define-app-element.js';
import {VirAuthModal} from './vir-auth-modal.element.js';
import {VirSettingsModal} from './vir-settings-modal.element.js';

/** The app-wide modals. Settings opens through `context.openSettings`; auth opens itself. */
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
                context: inputs.context,
            })}></${VirSettingsModal}>
            <${VirAuthModal}></${VirAuthModal}>
        `;
    },
});
