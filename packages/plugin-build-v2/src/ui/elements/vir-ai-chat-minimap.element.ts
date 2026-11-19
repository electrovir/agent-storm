import {defineAppElement} from '@agent-storm/core/frontend';
import {check} from '@augment-vir/assert';
import {clamp} from '@augment-vir/common';
import {extractEventTarget} from '@augment-vir/web';
import {classMap, css, html, listen, nothing} from 'element-vir';
import {micromark} from 'micromark';
import {gfm, gfmHtml} from 'micromark-extension-gfm';
import {
    createSizedIcon,
    LucideChevronDownIcon,
    LucideChevronUpIcon,
    tooltip,
    ViraButton,
    ViraColorVariant,
    ViraEmphasis,
    viraShadows,
    viraThemeByKeys,
} from 'vira';
import {type MinimapTurn} from '../../util/chat-minimap.js';
import {VirAiChatTimeline} from './vir-ai-chat-timeline.element.js';

const previousIcon = createSizedIcon(LucideChevronUpIcon, 16);
const nextIcon = createSizedIcon(LucideChevronDownIcon, 16);

/** Pixels between neighboring ticks while the rail has room for them. */
const tickSpacing = 8;
/** Pixels a jumped-to message lands below the top of the scroller. */
const jumpOffset = 24;
/** How wide each tick is drawn, by its distance from the hovered tick. Farther ticks use the last. */
const tickScales = [
    1,
    0.667,
    0.417,
    0.333,
] as const;

/** Markdown as one line of the text it renders. */
function toPlainText(markdown: string) {
    const rendered = new DOMParser().parseFromString(
        micromark(markdown, {
            extensions: [gfm()],
            htmlExtensions: [gfmHtml()],
        }),
        'text/html',
    );
    return (rendered.body.textContent || '').replace(/\s+/g, ' ').trim();
}

/**
 * Wraps a chat's scroller and draws a tick on its left edge for each user message, like T3 Code's
 * timeline minimap. Ticks for messages on screen are highlighted. Hovering a tick previews its
 * message and reply, and clicking it scrolls there. The scroller must be the only slotted child and
 * contain a {@link VirAiChatTimeline}.
 */
export const VirAiChatMinimap = defineAppElement<{
    turns: ReadonlyArray<Readonly<MinimapTurn>>;
}>()({
    tagName: 'vir-ai-chat-minimap',
    state() {
        return {
            /** The tick under the pointer or keyboard focus. */
            activeIndex: undefined as number | undefined,
            /** Ids of the turns with any part on screen. */
            inViewIds: [] as ReadonlyArray<string>,
            /** The first turn still on screen below the jump offset. */
            currentId: undefined as string | undefined,
            isAtEnd: true,
            scroller: undefined as HTMLElement | undefined,
            detachScroller: (() => {}) as () => void,
        };
    },
    cleanup({state}) {
        state.detachScroller();
    },
    styles: css`
        :host {
            position: relative;
            display: flex;
            flex-direction: column;
            flex-grow: 1;
            min-height: 0;
        }

        .rail {
            display: none;
            position: absolute;
            top: 50%;
            left: 12px;
            z-index: 20;
            width: 32px;
            transform: translateY(-50%);
            user-select: none;

            @media (min-width: 640px) and (pointer: fine) {
                display: block;
            }
        }

        .ticks {
            position: absolute;
            inset: 0;
            padding: 0;
            border: none;
            background: none;
            cursor: pointer;

            &::before {
                content: '';
                position: absolute;
                inset: -4px 0;
            }

            &:focus-visible {
                outline: 2px solid ${viraThemeByKeys.blue.foreground.body.foreground.value};
                outline-offset: 4px;
            }
        }

        .tick {
            position: absolute;
            left: 0;
            width: 24px;
            height: 2px;
            border-radius: 1px;
            transform-origin: left;
            transition:
                transform 150ms,
                background-color 150ms;
            pointer-events: none;
            background-color: ${viraThemeByKeys.grey.foreground.decoration.foreground.value};

            &.in-view {
                background-color: ${viraThemeByKeys.grey.foreground.placeholder.foreground.value};
            }

            &.active {
                background-color: ${viraThemeByKeys.grey.foreground.body.foreground.value};
            }
        }

        .step {
            position: absolute;
            left: 4px;
            width: 24px;
            height: 24px;
            opacity: 0;
            transform: translateX(-50%);
            transition: opacity 150ms;
            ${ViraButton.cssVars['vira-button-border-radius'].name}: 50%;

            &.previous {
                bottom: calc(100% + 6px);
            }

            &.next {
                top: calc(100% + 6px);
            }

            &:hover,
            &:focus-within {
                opacity: 1;
            }
        }

        .preview {
            position: absolute;
            left: 32px;
            display: flex;
            flex-direction: column;
            gap: 4px;
            box-sizing: border-box;
            width: 320px;
            max-width: calc(100vw - 96px);
            padding: 12px;
            border-radius: 12px;
            border: 1px solid ${viraThemeByKeys.grey.foreground.decoration.foreground.value};
            background-color: ${viraThemeByKeys.grey['behind-bg'].body.foreground.value};
            ${viraShadows.menuShadow}
            transform: translateY(-50%);
            pointer-events: none;
            font-size: 14px;

            & .user-text {
                overflow: hidden;
                white-space: nowrap;
                text-overflow: ellipsis;
                font-weight: 500;
                color: ${viraThemeByKeys.grey.foreground.body.foreground.value};
            }

            & .reply-text {
                display: -webkit-box;
                overflow: hidden;
                -webkit-box-orient: vertical;
                -webkit-line-clamp: 3;
                color: ${viraThemeByKeys.grey.foreground['non-body'].foreground.value};
            }
        }
    `,
    render({inputs, state, updateState, host}) {
        function findTurnEntries() {
            return Array.from(
                host.instanceState.scroller
                    ?.querySelector(VirAiChatTimeline.tagName)
                    ?.shadowRoot?.querySelectorAll<HTMLElement>('[data-turn-id]') || [],
            );
        }

        /** Re-reads which turns are on screen from the layout. */
        function refresh() {
            const scroller = host.instanceState.scroller;
            if (!scroller) {
                return;
            }
            const view = scroller.getBoundingClientRect();
            const contentBottom = scroller.firstElementChild?.getBoundingClientRect().bottom ?? 0;
            const entryTops = findTurnEntries().map((entry) => {
                return {
                    id: entry.dataset.turnId || '',
                    top: entry.getBoundingClientRect().top,
                };
            });
            const turnRanges = entryTops.map((entry, index) => {
                return {
                    id: entry.id,
                    top: entry.top,
                    bottom: entryTops[index + 1]?.top ?? contentBottom,
                };
            });
            const inView = turnRanges.filter((range) => {
                return range.top < view.bottom && range.bottom > view.top;
            });
            const next = {
                inViewIds: inView.map((range) => range.id),
                currentId: inView.find((range) => range.bottom > view.top + jumpOffset)?.id,
                isAtEnd: contentBottom <= view.bottom + 1,
            };
            if (
                !check.deepEquals(next, {
                    inViewIds: [
                        ...host.instanceState.inViewIds,
                    ],
                    currentId: host.instanceState.currentId,
                    isAtEnd: host.instanceState.isAtEnd,
                })
            ) {
                updateState(next);
            }
        }

        function attachScroller(scroller: HTMLElement | undefined) {
            state.detachScroller();
            if (!scroller) {
                updateState({
                    scroller: undefined,
                    detachScroller() {},
                });
                return;
            }
            const resizeObserver = new ResizeObserver(refresh);
            resizeObserver.observe(scroller);
            if (scroller.firstElementChild) {
                resizeObserver.observe(scroller.firstElementChild);
            }
            scroller.addEventListener('scroll', refresh, {
                passive: true,
            });
            updateState({
                scroller,
                detachScroller() {
                    resizeObserver.disconnect();
                    scroller.removeEventListener('scroll', refresh);
                },
            });
            refresh();
        }

        function jumpTo(turnId: string | undefined) {
            const scroller = host.instanceState.scroller;
            const entry = findTurnEntries().find((turnEntry) => {
                return turnEntry.dataset.turnId === turnId;
            });
            if (!scroller || !entry) {
                return;
            }
            scroller.scrollBy({
                top:
                    entry.getBoundingClientRect().top -
                    scroller.getBoundingClientRect().top -
                    jumpOffset,
                behavior: 'smooth',
            });
        }

        function toTopPercent(index: number) {
            return inputs.turns.length > 1 ? (index / (inputs.turns.length - 1)) * 100 : 50;
        }

        function findPointerIndex(event: Readonly<MouseEvent>) {
            const rail = extractEventTarget(event, HTMLButtonElement).getBoundingClientRect();
            const ratio = rail.height ? (event.clientY - rail.top) / rail.height : 0;
            return Math.round(
                clamp(ratio, {
                    min: 0,
                    max: 1,
                }) *
                    (inputs.turns.length - 1),
            );
        }

        function moveActiveIndex(delta: number) {
            updateState({
                activeIndex: clamp((state.activeIndex ?? 0) + delta, {
                    min: 0,
                    max: inputs.turns.length - 1,
                }),
            });
        }

        const slot = html`
            <slot
                ${listen('slotchange', (event) => {
                    const assigned = extractEventTarget(
                        event,
                        HTMLSlotElement,
                    ).assignedElements()[0];
                    if (assigned !== state.scroller) {
                        attachScroller(assigned instanceof HTMLElement ? assigned : undefined);
                    }
                })}
            ></slot>
        `;

        if (inputs.turns.length < 2) {
            return slot;
        }

        const currentIndex = inputs.turns.findIndex((turn) => turn.id === state.currentId);
        const previousTurn = currentIndex > 0 ? inputs.turns[currentIndex - 1] : undefined;
        const nextTurn =
            currentIndex >= 0 && !state.isAtEnd ? inputs.turns[currentIndex + 1] : undefined;
        const activeTurn =
            state.activeIndex == undefined ? undefined : inputs.turns[state.activeIndex];
        const activeUserText = activeTurn ? toPlainText(activeTurn.userText) : '';

        return html`
            ${slot}
            <div
                class="rail"
                style=${css`
                    height: min(
                        ${Math.max(1, (inputs.turns.length - 1) * tickSpacing)}px,
                        calc(100% - 240px)
                    );
                `}
                ${listen('wheel', (event) => {
                    if (!state.scroller || event.ctrlKey) {
                        return;
                    }
                    event.preventDefault();
                    state.scroller.scrollBy({
                        top:
                            event.deltaMode === WheelEvent.DOM_DELTA_LINE
                                ? event.deltaY * 16
                                : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
                                  ? event.deltaY * state.scroller.clientHeight
                                  : event.deltaY,
                    });
                })}
            >
                <${ViraButton.assign({
                    icon: previousIcon,
                    color: ViraColorVariant.Neutral,
                    buttonEmphasis: ViraEmphasis.Subtle,
                    isDisabled: !previousTurn,
                })}
                    class="step previous"
                    ${tooltip('Previous turn')}
                    aria-label="Previous turn"
                    ${listen('click', () => {
                        if (previousTurn) {
                            jumpTo(previousTurn.id);
                        }
                    })}
                ></${ViraButton}>
                <button
                    class="ticks"
                    type="button"
                    aria-label=${`Jump to message: ${activeUserText || 'User message'}`}
                    ${listen('mousedown', (event) => {
                        /** Keeps focus, and its keyboard highlight, off the rail on a click. */
                        event.preventDefault();
                    })}
                    ${listen('mousemove', (event) => {
                        const activeIndex = findPointerIndex(event);
                        if (activeIndex !== state.activeIndex) {
                            updateState({
                                activeIndex,
                            });
                        }
                    })}
                    ${listen('mouseleave', () => {
                        updateState({
                            activeIndex: undefined,
                        });
                    })}
                    ${listen('click', (event) => {
                        jumpTo(inputs.turns[findPointerIndex(event)]?.id);
                    })}
                    ${listen('focus', () => {
                        updateState({
                            activeIndex: Math.max(0, currentIndex),
                        });
                    })}
                    ${listen('blur', () => {
                        updateState({
                            activeIndex: undefined,
                        });
                    })}
                    ${listen('keydown', (event) => {
                        const handlers: Readonly<Record<string, () => void>> = {
                            ArrowUp() {
                                moveActiveIndex(-1);
                            },
                            ArrowDown() {
                                moveActiveIndex(1);
                            },
                            Home() {
                                updateState({
                                    activeIndex: 0,
                                });
                            },
                            End() {
                                updateState({
                                    activeIndex: inputs.turns.length - 1,
                                });
                            },
                            Enter() {
                                jumpTo(activeTurn?.id);
                            },
                            ' '() {
                                jumpTo(activeTurn?.id);
                            },
                        };
                        const handler = handlers[event.key];
                        if (handler) {
                            event.preventDefault();
                            handler();
                        }
                    })}
                >
                    ${inputs.turns.map((turn, index) => {
                        const distance =
                            state.activeIndex == undefined
                                ? tickScales.length - 1
                                : Math.abs(index - state.activeIndex);
                        return html`
                            <span
                                class=${classMap({
                                    tick: true,
                                    'in-view': state.inViewIds.includes(turn.id),
                                    active: distance === 0,
                                })}
                                style=${css`
                                    top: ${toTopPercent(index)}%;
                                    transform: translateY(-50%)
                                        scaleX(${tickScales[distance] ?? tickScales[3]});
                                `}
                            ></span>
                        `;
                    })}
                </button>
                ${activeTurn && state.activeIndex != undefined
                    ? html`
                          <div
                              class="preview"
                              style=${css`
                                  top: ${toTopPercent(state.activeIndex)}%;
                              `}
                          >
                              <span class="user-text">${activeUserText || 'User message'}</span>
                              ${activeTurn.replyText
                                  ? html`
                                        <span class="reply-text">
                                            ${toPlainText(activeTurn.replyText)}
                                        </span>
                                    `
                                  : nothing}
                          </div>
                      `
                    : nothing}
                <${ViraButton.assign({
                    icon: nextIcon,
                    color: ViraColorVariant.Neutral,
                    buttonEmphasis: ViraEmphasis.Subtle,
                    isDisabled: !nextTurn,
                })}
                    class="step next"
                    ${tooltip('Next turn')}
                    aria-label="Next turn"
                    ${listen('click', () => {
                        if (nextTurn) {
                            jumpTo(nextTurn.id);
                        }
                    })}
                ></${ViraButton}>
            </div>
        `;
    },
});
