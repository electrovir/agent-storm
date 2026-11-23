/** Recursive, so its return type can't be inferred. */
function findDeepestElementAt({
    root,
    x,
    y,
}: Readonly<{
    root: Readonly<Pick<DocumentOrShadowRoot, 'elementFromPoint'>>;
    x: number;
    y: number;
}>): Element | undefined {
    const element = root.elementFromPoint(x, y) || undefined;
    const inner = element?.shadowRoot?.elementFromPoint(x, y);
    /** Stops if a shadow root hands back its own host, so this can't recurse forever. */
    return element?.shadowRoot && inner && inner !== element
        ? findDeepestElementAt({
              root: element.shadowRoot,
              x,
              y,
          })
        : element;
}

/**
 * `element` and its ancestors below `stopAt`, crossing out of shadow roots, or `undefined` when
 * `stopAt` doesn't hold `element`. Recursive, so its return type can't be inferred.
 */
function listAncestorsWithin({
    element,
    stopAt,
}: Readonly<{
    element: Element;
    stopAt: Element;
}>): Element[] | undefined {
    if (element === stopAt) {
        return [];
    }
    const rootNode = element.getRootNode();
    const parent =
        element.parentElement || (rootNode instanceof ShadowRoot ? rootNode.host : undefined);
    const rest = parent
        ? listAncestorsWithin({
              element: parent,
              stopAt,
          })
        : undefined;
    return (
        rest && [
            element,
            ...rest,
        ]
    );
}

/**
 * Keeps `scroller` scrolled to its end while its content or its own size changes, as long as the
 * user was already at the end. Scrolling up stops it, and scrolling back to the end resumes it.
 * Away from the end, content that changes size above the view (such as images that finish loading)
 * doesn't move what's in view. Only the scroller and its first element child are watched for size
 * changes. Returns the disconnect.
 */
export function stickToBottom(scroller: HTMLElement) {
    /**
     * Not `flex-direction: column-reverse`, which also starts at the end: on iOS it jumps around
     * while a reply streams in.
     */
    const pin = {
        isAtBottom: true,
        scrollTop: scroller.scrollTop,
        anchors: [] as ReadonlyArray<Readonly<{element: Element; top: number}>>,
    };

    /** Elements in view, deepest first, with where they sit now. */
    function findAnchors() {
        const bounds = scroller.getBoundingClientRect();
        return [
            0.1,
            0.5,
            0.9,
        ].flatMap((fraction) => {
            const element = findDeepestElementAt({
                root: document,
                x: bounds.left + bounds.width / 2,
                y: bounds.top + bounds.height * fraction,
            });
            return (
                element
                    ? listAncestorsWithin({
                          element,
                          stopAt: scroller,
                      }) || []
                    : []
            ).flatMap((ancestor) => {
                const rect = ancestor.getBoundingClientRect();
                /**
                 * An element as tall as the view, such as the whole timeline, stays put when
                 * content inside it above the view changes size.
                 */
                return rect.height < bounds.height
                    ? [
                          {
                              element: ancestor,
                              top: rect.top,
                          },
                      ]
                    : [];
            });
        });
    }

    function remember() {
        pin.scrollTop = scroller.scrollTop;
        pin.anchors = pin.isAtBottom ? [] : findAnchors();
    }

    function updatePin() {
        /**
         * Only scrolling up unpins. Content can grow between the scroll that `keepInPlace` sets and
         * the scroll event it fires, leaving the scroller short of the end without the user
         * moving.
         */
        pin.isAtBottom =
            scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 2 ||
            (pin.isAtBottom && scroller.scrollTop >= pin.scrollTop - 1);
        remember();
    }

    function keepInPlace() {
        if (pin.isAtBottom) {
            scroller.scrollTop = scroller.scrollHeight;
        } else {
            const anchor = pin.anchors.find(({element}) => element.isConnected);
            if (anchor) {
                scroller.scrollTop += anchor.element.getBoundingClientRect().top - anchor.top;
            }
        }
        remember();
    }

    const resizeObserver = new ResizeObserver(keepInPlace);
    resizeObserver.observe(scroller);
    if (scroller.firstElementChild) {
        resizeObserver.observe(scroller.firstElementChild);
    }
    scroller.addEventListener('scroll', updatePin, {
        passive: true,
    });
    keepInPlace();

    return () => {
        resizeObserver.disconnect();
        scroller.removeEventListener('scroll', updatePin);
    };
}
