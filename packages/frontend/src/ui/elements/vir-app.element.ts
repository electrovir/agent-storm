import {css, defineElement, html} from 'element-vir';
import {VirTerminal} from './vir-terminal.element.js';

export const VirApp = defineElement()({
    tagName: 'vir-app',
    styles: css`
        :host {
            display: block;
            width: 100vw;
            height: 100vh;
        }
    `,
    render() {
        return html`
            <${VirTerminal}></${VirTerminal}>
        `;
    },
});
