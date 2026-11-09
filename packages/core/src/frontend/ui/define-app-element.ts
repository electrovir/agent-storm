import {wrapDefineElement} from 'element-vir';
import {reportRenderError} from '../util/client-error-log.js';

/** Same as `defineElement`, but every element reports its render failures to the backend log. */
export const defineAppElement = wrapDefineElement<`vir-${string}`>({
    transformInputs(init) {
        return {
            ...init,
            options: {
                ...init.options,
                errorHandler: reportRenderError,
            },
        };
    },
});
