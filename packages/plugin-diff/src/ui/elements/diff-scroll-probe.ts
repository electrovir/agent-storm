import {reportClientError} from '@agent-storm/core/frontend';

/**
 * TEMPORARY diagnostic for the diff view's backward scroll jumps. Remove once the cause is found.
 * Every backward jump during a downward wheel scroll is shipped to the backend client error log
 * along with any programmatic scroll writes that happened just before it.
 */

type ScrollWrite = {
    at: number;
    stack: string;
    target: string;
    detail: string;
};

const recentWrites: ScrollWrite[] = [];
const patchState = {
    isPatched: false,
};

function describeElement(element: unknown) {
    if (!(element instanceof Element)) {
        return String(element);
    }
    return [
        element.tagName.toLowerCase(),
        ...element.classList,
    ].join('.');
}

function recordWrite(target: unknown, detail: string) {
    recentWrites.push({
        at: performance.now(),
        stack: new Error('scroll write').stack || '',
        target: describeElement(target),
        detail,
    });
    if (recentWrites.length > 30) {
        recentWrites.shift();
    }
}

function patchScrollWrites() {
    if (patchState.isPatched) {
        return;
    }
    patchState.isPatched = true;
    const scrollTopDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
    if (scrollTopDescriptor?.set) {
        Object.defineProperty(Element.prototype, 'scrollTop', {
            ...scrollTopDescriptor,
            set(this: Element, value: number) {
                recordWrite(this, `scrollTop=${value}`);
                scrollTopDescriptor.set?.call(this, value);
            },
        });
    }
    const elementPrototype = Element.prototype as unknown as Record<
        string,
        (...args: unknown[]) => unknown
    >;
    [
        'scrollTo',
        'scrollBy',
        'scrollIntoView',
        'scrollIntoViewIfNeeded',
    ].forEach((name) => {
        const original = elementPrototype[name];
        if (!original) {
            return;
        }
        elementPrototype[name] = function (this: Element, ...args: unknown[]) {
            recordWrite(this, `${name}(${JSON.stringify(args)})`);
            return original.apply(this, args);
        };
    });
    const windowObject = globalThis as unknown as Record<string, (...args: unknown[]) => unknown>;
    [
        'scrollTo',
        'scrollBy',
    ].forEach((name) => {
        const original = windowObject[name];
        if (!original) {
            return;
        }
        windowObject[name] = (...args: unknown[]) => {
            recordWrite('window', `${name}(${JSON.stringify(args)})`);
            return original.apply(globalThis, args);
        };
    });
}

function describeFocus(root: DocumentOrShadowRoot) {
    const chain: string[] = [];
    const cursor = {
        root: root as DocumentOrShadowRoot | undefined,
    };
    while (cursor.root && chain.length < 8) {
        const active: Element | null = cursor.root.activeElement;
        if (!active) {
            break;
        }
        chain.push(describeElement(active));
        cursor.root = active.shadowRoot ?? undefined;
    }
    return chain.join(' > ');
}

function describeSelection() {
    const selection = document.getSelection();
    if (!selection || !selection.rangeCount) {
        return 'none';
    }
    const anchor = selection.anchorNode;
    const anchorElement = anchor instanceof Element ? anchor : anchor?.parentElement;
    return `${selection.type} at ${describeElement(anchorElement)} "${(anchor?.textContent || '').slice(0, 40)}"`;
}

/** TEMPORARY: logs every backward jump of a scroller inside `host` while the user scrolls down. */
export function probeScrollJumps(host: HTMLElement, viewName: string) {
    patchScrollWrites();
    const listenedElements = new WeakSet<Element>();
    const lastWheel = {
        at: -Infinity,
        deltaY: 0,
    };
    host.addEventListener(
        'wheel',
        (event) => {
            lastWheel.at = performance.now();
            lastWheel.deltaY = event.deltaY;
            event.composedPath().forEach((target) => {
                if (target instanceof Element && !listenedElements.has(target)) {
                    listenedElements.add(target);
                    target.addEventListener('scroll', onScroll, {
                        passive: true,
                    });
                }
            });
        },
        {
            passive: true,
            capture: true,
        },
    );
    const lastPositions = new WeakMap<
        Element,
        {
            top: number;
            height: number;
        }
    >();
    function onScroll(event: Event) {
        const target = event.target;
        if (!(target instanceof Element)) {
            return;
        }
        const position = {
            top: target.scrollTop,
            height: target.scrollHeight,
        };
        const previous = lastPositions.get(target);
        lastPositions.set(target, position);
        const now = performance.now();
        if (
            !previous ||
            position.top >= previous.top - 40 ||
            now - lastWheel.at > 400 ||
            lastWheel.deltaY <= 0
        ) {
            return;
        }
        const writes = recentWrites
            .filter((write) => now - write.at < 500)
            .map((write) => {
                return {
                    agoMs: Math.round(now - write.at),
                    target: write.target,
                    detail: write.detail,
                    stack: write.stack.split('\n').slice(1, 14).join(' | '),
                };
            });
        reportClientError({
            source: 'scroll-probe',
            error: new Error(
                JSON.stringify({
                    at: Date.now(),
                    view: viewName,
                    scroller: describeElement(target),
                    fromTop: Math.round(previous.top),
                    toTop: Math.round(position.top),
                    fromHeight: previous.height,
                    toHeight: position.height,
                    clientHeight: target.clientHeight,
                    msSinceWheel: Math.round(now - lastWheel.at),
                    wheelDeltaY: lastWheel.deltaY,
                    focus: describeFocus(document),
                    selection: describeSelection(),
                    writes,
                }),
            ),
        });
    }
}
