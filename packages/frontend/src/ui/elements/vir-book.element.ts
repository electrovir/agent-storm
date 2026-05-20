import {BookMainRoute, ElementBookApp} from 'element-book';
import {css, defineElement, html, listen} from 'element-vir';
import {router} from '../../util/router.js';
import {buttonsPage} from './buttons.book-page.js';

export const VirBook = defineElement<{
    subPaths: ReadonlyArray<string>;
}>()({
    tagName: 'vir-book',
    styles: css`
        :host {
            display: block;
            width: 100%;
            height: 100%;
        }

        element-book-app {
            width: 100%;
            height: 100%;
        }
    `,
    render({inputs}) {
        return html`
            <${ElementBookApp.assign({
                pages: [buttonsPage],
                elementBookRoutePaths: [
                    BookMainRoute.Book,
                    ...inputs.subPaths,
                ],
            })}
                ${listen(ElementBookApp.events.pathUpdate, (event) => {
                    const newPaths = event.detail;
                    router.setRoute({
                        paths: [
                            'book',
                            ...newPaths.slice(1),
                        ] as ['book', ...string[]],
                    });
                })}
            ></${ElementBookApp}>
        `;
    },
});
