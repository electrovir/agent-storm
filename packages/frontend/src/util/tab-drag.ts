/** How far the pointer moves before a press becomes a drag, so a plain click still clicks. */
const dragThresholdPx = 5;

/**
 * The tabs a `ViraTabs` shows in its bar, in order. Tabs it hid or collapsed into its overflow menu
 * aren't among them.
 */
export function listInlineTabElements(viraTabs: Element | null | undefined) {
    return Array.from(
        viraTabs?.shadowRoot?.querySelectorAll('.tabs-container:not(.tabs-measure) .tab-item') ||
            [],
    );
}

/**
 * The index of the element under the pointer, or -1. Hit-tested by position because `ViraTabs`
 * turns off pointer events on its selected tab, so the event target can't say which tab it is.
 */
export function findElementIndexAt({
    elements,
    clientX,
    clientY,
}: Readonly<{
    elements: ReadonlyArray<Element>;
    clientX: number;
    clientY: number;
}>) {
    return elements.findIndex((element) => {
        const rect = element.getBoundingClientRect();
        return (
            clientX >= rect.left &&
            clientX <= rect.right &&
            clientY >= rect.top &&
            clientY <= rect.bottom
        );
    });
}

/** How many of `elements` sit before the pointer: past their midpoint along the strip's axis. */
export function countElementsBefore({
    elements,
    position,
    isVertical,
}: Readonly<{
    elements: ReadonlyArray<Element>;
    /** The pointer's x, or its y for a vertical strip. */
    position: number;
    isVertical: boolean;
}>) {
    return elements.filter((element) => {
        const rect = element.getBoundingClientRect();
        return isVertical
            ? rect.top + rect.height / 2 < position
            : rect.left + rect.width / 2 < position;
    }).length;
}

/**
 * Follows a mouse or pen press until it's released, and reports it as a drag once it moves far
 * enough. Touch is left alone, so a finger still scrolls and long-presses. Once a drag starts, the
 * pointer is captured (so a terminal under it can't take the events) and the click that ends it is
 * swallowed (so dropping a tab doesn't also click whatever it was dropped on).
 */
export function trackPointerDrag({
    event,
    captureElement,
    onStart,
    onMove,
    onEnd,
}: Readonly<{
    event: Readonly<PointerEvent>;
    captureElement: Element;
    onStart: () => void;
    onMove: (event: PointerEvent) => void;
    /** Given the release, or undefined when the drag was cancelled. */
    onEnd: (event: PointerEvent | undefined) => void;
}>) {
    if (event.pointerType === 'touch' || event.button !== 0) {
        return;
    }
    const drag = {
        isDragging: false,
        bodyUserSelect: '',
        bodyCursor: '',
    };

    function handleMove(moveEvent: PointerEvent) {
        if (moveEvent.pointerId !== event.pointerId) {
            return;
        }
        if (!drag.isDragging) {
            if (
                Math.hypot(moveEvent.clientX - event.clientX, moveEvent.clientY - event.clientY) <
                dragThresholdPx
            ) {
                return;
            }
            drag.isDragging = true;
            try {
                captureElement.setPointerCapture(event.pointerId);
            } catch {
                /**
                 * The pointer can already be gone (released between events); the drag still works
                 * without capture.
                 */
            }
            drag.bodyUserSelect = document.body.style.userSelect;
            drag.bodyCursor = document.body.style.cursor;
            document.body.style.userSelect = 'none';
            document.body.style.cursor = 'grabbing';
            onStart();
        }
        onMove(moveEvent);
    }

    function swallowClick(clickEvent: MouseEvent) {
        clickEvent.stopPropagation();
        clickEvent.preventDefault();
    }

    function finish(endEvent: PointerEvent) {
        if (endEvent.pointerId !== event.pointerId) {
            return;
        }
        window.removeEventListener('pointermove', handleMove);
        window.removeEventListener('pointerup', finish);
        window.removeEventListener('pointercancel', finish);
        if (!drag.isDragging) {
            return;
        }
        document.body.style.userSelect = drag.bodyUserSelect;
        document.body.style.cursor = drag.bodyCursor;
        window.addEventListener('click', swallowClick, {
            capture: true,
            once: true,
        });
        /** A release with no click after it (it ended outside the window) mustn't eat a later click. */
        setTimeout(() => {
            window.removeEventListener('click', swallowClick, {
                capture: true,
            });
        });
        onEnd(endEvent.type === 'pointerup' ? endEvent : undefined);
    }

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
}
