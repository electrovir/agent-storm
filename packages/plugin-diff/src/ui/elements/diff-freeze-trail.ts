import {isDebugLogEnabled, traceFreezeSpan} from '@agent-storm/core/frontend';
import {EditorView} from '@codemirror/view';

const patchState = {
    isPatched: false,
};

function describeView(view: EditorView) {
    const host = view.root instanceof ShadowRoot ? view.root.host.tagName.toLowerCase() : 'page';
    return `${view.state.doc.length} chars in ${host}`;
}

/**
 * TEMPORARY diagnostic for the Diff pane's main-thread freezes. Remove once the cause is found.
 *
 * Brackets every CodeMirror view's update and measure pass in a freeze-trail span, so a freeze
 * inside CodeMirror shows which pass never finished and how big its document was. Patches
 * CodeMirror the first time it runs with the `enableDebugLogs` setting on.
 */
export function traceEditorPasses() {
    if (patchState.isPatched || !isDebugLogEnabled()) {
        return;
    }
    patchState.isPatched = true;
    /** `measure` is internal to CodeMirror, so it isn't on the public type. */
    const prototype = EditorView.prototype satisfies object as unknown as Record<
        string,
        (...args: unknown[]) => unknown
    >;
    [
        'update',
        'measure',
    ].forEach((name) => {
        const original = prototype[name];
        if (!original) {
            return;
        }
        prototype[name] = function (this: EditorView, ...args: unknown[]) {
            return traceFreezeSpan(`codemirror ${name} (${describeView(this)})`, () => {
                return original.apply(this, args);
            });
        };
    });
}
