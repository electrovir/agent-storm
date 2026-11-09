import {defineActivity, VirBook} from '@agent-storm/core/frontend';
import {html, listen} from 'element-vir';

/** Element-book pages for checking UI states. */
export const debugActivity = defineActivity({
    id: 'debug',
    label: 'Debug',
    isEnabledByDefault: false,
    mobileMenuTitle: 'Debug',
    sidebar: undefined,
    isKeptMounted: false,
    render({route}) {
        return html`
            <${VirBook.assign({
                subPaths: route.subPaths,
            })}
                ${listen(VirBook.events.routeChange, (event) => {
                    route.navigate(event.detail);
                })}
            ></${VirBook}>
        `;
    },
});
