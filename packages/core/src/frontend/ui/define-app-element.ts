import {wrapDefineElement} from 'element-vir';
import {reportRenderError} from '../util/client-error-log.js';
import {traceFreezeSpan} from '../util/debug-log.js';
import {PerfCategory, recordPerf} from '../util/perf-stats.js';

/**
 * Same as `defineElement`, but every element reports its render failures to the backend log and
 * times its renders for the perf log.
 */
export const defineAppElement = wrapDefineElement<`vir-${string}`>({
    transformInputs(init) {
        return {
            ...init,
            render(params) {
                const startedAt = performance.now();
                try {
                    return traceFreezeSpan(`render ${init.tagName}`, () => init.render(params));
                } finally {
                    recordPerf({
                        category: PerfCategory.Render,
                        name: init.tagName,
                        milliseconds: performance.now() - startedAt,
                    });
                }
            },
            options: {
                ...init.options,
                errorHandler: reportRenderError,
            },
        };
    },
});
