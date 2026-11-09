import {wait} from '@augment-vir/common';
import {type FitAddon} from '@xterm/addon-fit';
import {type Terminal} from '@xterm/xterm';

/**
 * How many animation frames a fit will wait for xterm to produce a usable cell measurement before
 * giving up. Measurement normally lands on the frame right after a hidden pane is revealed; the
 * ceiling only exists so a pane that never becomes measurable can't retry forever.
 */
const maxFitRetryFrames = 30;

/**
 * How many frames in a row the proposed dimensions have to come back identical before an activation
 * fit trusts them.
 *
 * A terminal that was hidden measured its cell box against whatever layout it last had. Revealing
 * the pane doesn't re-measure it synchronously — xterm does that off its own observers, a frame or
 * more later. The proposal in between is a finite, plausible, wrong number, which is exactly what
 * the retry loop can't catch: it only rejects unreadable proposals. Waiting for the number to stop
 * moving is what says the re-measure has landed.
 */
export const stableFitFrames = 3;

/**
 * Builds the fit loop for one mounted terminal. `fitAndResend` is the sole entry point for
 * resizing: it supersedes any settle chain already in flight, waits for xterm's proposed size to
 * repeat `requiredStableFrames` times, then fits, pushes the size to the pty, and opens the write
 * gate.
 */
export function createTerminalFitter({
    element,
    terminal,
    fitAddon,
    sendResize,
    openWriteGate,
}: Readonly<{
    element: HTMLElement;
    terminal: Terminal;
    fitAddon: FitAddon;
    sendResize: () => void;
    openWriteGate: () => void;
}>) {
    /**
     * Redraw every glyph on screen.
     *
     * The WebGL renderer keeps rendered glyphs in a texture atlas, and a canvas inside a `display:
     * none` subtree can come back with that atlas corrupt or dropped — text renders as garbage,
     * blank boxes, or the wrong characters even though the terminal's contents are correct.
     * `clearTextureAtlas` throws the cached glyphs away and `refresh` redraws the visible rows from
     * the buffer. Dragging the divider used to be the only thing that fixed it, because a resize
     * rebuilds the atlas as a side effect.
     */
    function repaintGlyphs() {
        terminal.clearTextureAtlas();
        terminal.refresh(0, terminal.rows - 1);
    }

    /**
     * Do what dragging the pane divider does, because that is the only thing that has ever reliably
     * fixed a mangled pane.
     *
     * A pane comes back with the right dimensions and the wrong picture: xterm's buffer holds lines
     * wrapped at an older width, and the TUI's own frame was painted against an older geometry.
     * Neither repaints on its own. `refresh` redraws the same wrong content, and re-wrapping xterm
     * alone leaves the TUI's frame stale, because the program in the pty was never told anything
     * changed. Only a real size change fixes both: xterm re-wraps, and the pty raises SIGWINCH so
     * the TUI repaints its whole screen.
     *
     * So change the size for real, one row taller, and change it back. Rows, not columns: narrowing
     * even one column makes xterm re-wrap every full-width line (Claude Code draws its borders edge
     * to edge), which pushes fragments of the old frame into the scrollback before the TUI's
     * repaint arrives, and the TUI only clears the visible screen. Taller first, because Claude
     * Code ignores a row being added and only repaints when one is taken away; the shrink back then
     * pushes out the row the grow pulled in and the repaint covers the whole screen. The pause
     * between the two lets the TUI see the taller size, or it would see no change at all.
     */
    async function nudgePtySize() {
        const restoreRows = terminal.rows;
        terminal.resize(terminal.cols, restoreRows + 1);
        sendResize();
        await wait({
            milliseconds: 80,
        });
        terminal.resize(terminal.cols, restoreRows);
        sendResize();
    }

    /**
     * Which settle chain is the live one. Every entry point bumps it, so an older chain still
     * walking its frames sees a mismatch and stops. A counter rather than a boolean "busy" flag on
     * purpose: a flag has to be cleared on every exit path, and the one path that missed it — an
     * activation chain that never reached its final frame — left the terminal unable to resize for
     * the life of the socket. A stale generation can only ever be superseded, never stuck.
     */
    const fitGeneration = {
        current: 0,
    };

    /**
     * Fit, then push the size to the pty — but only once xterm's proposal has repeated
     * `requiredStableFrames` times.
     *
     * A terminal `open()`ed inside a hidden pane measured its cell box against whatever layout it
     * last had. Revealing the pane does not re-measure it synchronously; xterm does that off its
     * own observers a frame or more later. Fitting immediately means fitting to that stale box: the
     * pty gets a wrong width, the TUI redraws at it, and the correct fit arriving three frames
     * later leaves both renderings interleaved in the buffer. Waiting for the number to stop moving
     * is what says the re-measure has landed.
     *
     * Recursion is why this carries a return-type annotation.
     */
    function fitWhenSettled({
        generation,
        remainingFrames,
        previous,
        stableFrames,
        requiredStableFrames,
    }: Readonly<{
        generation: number;
        remainingFrames: number;
        previous: Readonly<{cols: number; rows: number}> | undefined;
        stableFrames: number;
        requiredStableFrames: number;
    }>): void {
        /**
         * A superseded generation is abandoned outright. So is a pane with no real layout —
         * `display: none` because the user switched folders. Fitting that would shrink xterm to its
         * minimum columns and push that to the pty, and the TUI's narrow redraw would land in the
         * scrollback for the user to find on their return. The ResizeObserver fires again when the
         * pane regains a box.
         */
        if (
            generation !== fitGeneration.current ||
            element.offsetWidth < 10 ||
            element.offsetHeight < 10
        ) {
            return;
        }
        function retry(
            nextPrevious: Readonly<{cols: number; rows: number}> | undefined,
            nextStableFrames: number,
        ) {
            requestAnimationFrame(() => {
                return fitWhenSettled({
                    generation,
                    remainingFrames: remainingFrames - 1,
                    previous: nextPrevious,
                    stableFrames: nextStableFrames,
                    requiredStableFrames,
                });
            });
        }
        const proposed = fitAddon.proposeDimensions();
        if (!proposed || !Number.isFinite(proposed.cols) || !Number.isFinite(proposed.rows)) {
            if (remainingFrames > 0) {
                retry(undefined, 0);
            }
            return;
        }
        const nextStableFrames =
            proposed.cols === previous?.cols && proposed.rows === previous.rows
                ? stableFrames + 1
                : 0;
        if (nextStableFrames < requiredStableFrames && remainingFrames > 0) {
            retry(proposed, nextStableFrames);
            return;
        }
        fitAddon.fit();
        /**
         * Sent even when xterm was already this size. A socket that has never reported a size
         * leaves its pty at the 120×32 it was spawned with, and the daemon skips subscribers with
         * no size when it picks a pane's dimensions — so a pane that mounted hidden and came up
         * already matching its own layout would wrap at 120 forever, until a manual drag finally
         * sent something. Re-sending an unchanged size costs nothing: the kernel raises no SIGWINCH
         * when the dimensions don't move.
         */
        sendResize();
        openWriteGate();
        repaintGlyphs();
        /*
         * Always, not just when the fit was a no-op. Whether the pty sees a size change is decided
         * by the size *it* already had, which this element cannot know: the pty outlives every
         * mount, so a tab switched away from and back remounts xterm at its construction-time
         * 120x32, fits to the same dimensions the pty already had, and sends a size that raises no
         * SIGWINCH — leaving the replayed scrollback wrapped however it was and the TUI with no
         * reason to repaint. The nudge is the only thing that has ever reliably fixed that, and
         * running it unconditionally costs one extra repaint.
         */
        void nudgePtySize();
    }

    /**
     * Supersedes any chain already in flight, which also debounces a divider drag: each entry
     * restarts the wait, so the pty hears one size a few frames after the drag stops instead of one
     * per pointer move.
     */
    function fitAndResend(requiredStableFrames: number) {
        fitGeneration.current += 1;
        fitWhenSettled({
            generation: fitGeneration.current,
            remainingFrames: maxFitRetryFrames,
            previous: undefined,
            stableFrames: 0,
            requiredStableFrames,
        });
    }

    return {
        fitAndResend,
        repaintGlyphs,
    };
}
