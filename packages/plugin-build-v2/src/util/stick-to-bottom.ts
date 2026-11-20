/**
 * Keeps `scroller` scrolled to its end while its content or its own size changes, as long as the
 * user was already at the end. Scrolling away stops it, and scrolling back to the end resumes it.
 * Only the scroller and its first element child are watched for size changes. Returns the
 * disconnect.
 */
export function stickToBottom(scroller: HTMLElement) {
    /**
     * Not `flex-direction: column-reverse`, which also starts at the end: on iOS it jumps around
     * while a reply streams in.
     */
    const pin = {
        isAtBottom: true,
    };

    function updateIsAtBottom() {
        /** Fractional scroll offsets on high-density screens can stop a pixel short of the end. */
        pin.isAtBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 2;
    }

    function scrollToBottomIfPinned() {
        if (pin.isAtBottom) {
            scroller.scrollTop = scroller.scrollHeight;
        }
    }

    const resizeObserver = new ResizeObserver(scrollToBottomIfPinned);
    resizeObserver.observe(scroller);
    if (scroller.firstElementChild) {
        resizeObserver.observe(scroller.firstElementChild);
    }
    scroller.addEventListener('scroll', updateIsAtBottom, {
        passive: true,
    });
    scrollToBottomIfPinned();

    return () => {
        resizeObserver.disconnect();
        scroller.removeEventListener('scroll', updateIsAtBottom);
    };
}
