/**
 * Writes the visual viewport's height, which excludes the on-screen keyboard, to an
 * `--app-viewport-height` CSS variable on `host` and on the document element, now and whenever it
 * changes. Returns the disconnect. Does nothing in browsers without the Visual Viewport API.
 */
export function trackVisualViewportHeight(host: HTMLElement) {
    /**
     * Relying on iOS Safari to honor `dvh` updates doesn't work: it doesn't do that reliably.
     * Listening to both `resize` and `scroll` covers iOS's quirk of firing only the scroll event on
     * some keyboard transitions. The Visual Viewport API is missing on older browsers; skipping the
     * wiring there is safe (the `100dvh` fallback still applies).
     */
    const viewport = window.visualViewport ?? undefined;
    if (!viewport) {
        return () => {};
    }
    function updateViewportHeight() {
        const measured = viewport?.height;
        if (typeof measured !== 'number' || measured <= 0) {
            return;
        }
        const value = `${measured}px`;
        /**
         * Write the measured pixel height to both the host (where `:host { height: var(...) }`
         * picks it up) and the document element so the global `html, body` rule in `index.css` can
         * read it too. The body needs to match — if it stayed at `100dvh` (full screen, including
         * the keyboard area), iOS could still pan its visual viewport inside the body and push our
         * tab bar above the fold even though `overflow: hidden` clips document scrolling.
         */
        host.style.setProperty('--app-viewport-height', value);
        document.documentElement.style.setProperty('--app-viewport-height', value);
    }
    updateViewportHeight();
    viewport.addEventListener('resize', updateViewportHeight);
    viewport.addEventListener('scroll', updateViewportHeight);
    return () => {
        viewport.removeEventListener('resize', updateViewportHeight);
        viewport.removeEventListener('scroll', updateViewportHeight);
    };
}
