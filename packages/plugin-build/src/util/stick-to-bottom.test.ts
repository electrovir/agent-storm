import {assert, assertWrap} from '@augment-vir/assert';
import {createArray} from '@augment-vir/common';
import {describe, it} from '@augment-vir/test';
import {stickToBottom} from './stick-to-bottom.js';

function createBlock(height: number) {
    const block = document.createElement('div');
    block.style.height = `${height}px`;
    return block;
}

/** A scroller with browser scroll anchoring off, so only `stickToBottom` can keep the view in place. */
function setUpScroller() {
    const scroller = document.createElement('div');
    scroller.style.height = '100px';
    scroller.style.overflowY = 'auto';
    scroller.style.overflowAnchor = 'none';
    const content = document.createElement('div');
    content.append(...createArray(10, () => createBlock(50)));
    scroller.append(content);
    document.body.append(scroller);
    return {
        scroller,
        content,
        removeStickToBottom: stickToBottom(scroller),
    };
}

async function waitForFrames() {
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
}

describe(stickToBottom.name, () => {
    it('stays at the end while content grows, even before its own scroll event', async () => {
        const {scroller, content, removeStickToBottom} = setUpScroller();
        await waitForFrames();
        content.append(createBlock(50));
        /** Grows again before the scroll event from the first growth fires. */
        await new Promise((resolve) => {
            new ResizeObserver((_entries, observer) => {
                observer.disconnect();
                setTimeout(() => {
                    content.append(createBlock(50));
                    resolve(undefined);
                });
            }).observe(content);
        });
        await waitForFrames();

        assert.strictEquals(scroller.scrollTop, scroller.scrollHeight - scroller.clientHeight);
        removeStickToBottom();
        scroller.remove();
    });

    it('keeps the view in place when content above it grows', async () => {
        const {scroller, content, removeStickToBottom} = setUpScroller();
        await waitForFrames();
        scroller.scrollTop = 200;
        await waitForFrames();
        const inView = assertWrap.isDefined(content.children[5]);
        const topBefore = inView.getBoundingClientRect().top;
        content.prepend(createBlock(80));
        await waitForFrames();

        assert.deepEquals(
            {
                top: inView.getBoundingClientRect().top,
                scrollTop: scroller.scrollTop,
            },
            {
                top: topBefore,
                scrollTop: 280,
            },
        );
        removeStickToBottom();
        scroller.remove();
    });

    it('keeps its scroll position when it moves down and shrinks at once', async () => {
        const {scroller, removeStickToBottom} = setUpScroller();
        await waitForFrames();
        scroller.scrollTop = 200;
        await waitForFrames();
        scroller.style.marginTop = '40px';
        scroller.style.height = '60px';
        await waitForFrames();

        assert.strictEquals(scroller.scrollTop, 200);
        removeStickToBottom();
        scroller.remove();
    });
});
