import {defineAppElement, spinAnimationCss, spinKeyframesCss} from '@agent-storm/core/frontend';
import {type AnyDuration} from 'date-vir';
import {
    classMap,
    css,
    defineElementEvent,
    html,
    listen,
    nothing,
    type HtmlInterpolation,
    type TemplateResult,
} from 'element-vir';
import {
    createSizedIcon,
    LucideChevronRightIcon,
    LucideCircleAlertIcon,
    LucideQuoteIcon,
    tooltip,
    ViraButton,
    ViraColorVariant,
    ViraIcon,
    ViraSize,
    viraThemeByKeys,
    type ViraIconSvg,
} from 'vira';
import {
    ThreadItemKind,
    ThreadItemStatus,
    type ComposerCommand,
    type ThreadItem,
} from '../../build-v2-api.js';
import {splitComposerCommandMentions} from '../../util/composer-commands.js';
import {splitMessageAttachments, type MessageAttachment} from '../../util/message-attachments.js';
import {
    buildTimeline,
    summarizeWork,
    TimelineEntryKind,
    type TimelineEntry,
} from '../../util/thread-timeline.js';
import {countDiffLines, diffLineStyles, renderDiffLines} from './diff-lines.js';
import {chatMarkdownStyles, renderChatImages, renderChatMarkdown} from './markdown-styles.js';
import {workingIcon, workItemDisplays} from './thread-display.js';
import {findCommandMentionColor} from './vir-ai-chat-command-menu.element.js';
import {VirAiChatLocalImage} from './vir-ai-chat-local-image.element.js';
import {VirAiChatSentAttachment} from './vir-ai-chat-sent-attachment.element.js';

function isFailedStatus(status: ThreadItemStatus) {
    return status === ThreadItemStatus.Failed || status === ThreadItemStatus.Declined;
}

function renderIcon({icon, isFailed}: Readonly<{icon: ViraIconSvg; isFailed?: boolean}>) {
    return html`
        <${ViraIcon.assign({
            icon,
            fitContainer: true,
        })}
            class=${classMap({
                'row-icon': true,
                failed: !!isFailed,
            })}
        ></${ViraIcon}>
    `;
}

function renderSpinner() {
    return html`
        <${ViraIcon.assign({
            icon: workingIcon,
        })}
            class="spinner"
        ></${ViraIcon}>
    `;
}

function renderWorkLogLine({
    icon,
    label,
    trailing,
    isWorking,
}: Readonly<{
    icon: HtmlInterpolation;
    label: HtmlInterpolation;
    trailing: HtmlInterpolation;
    isWorking?: boolean | undefined;
}>) {
    return html`
        <div class="work-line">
            ${isWorking ? renderSpinner() : nothing}
            <span class="icon-cell">${icon}</span>
            <span class="line-label">${label}</span>
            ${trailing}
        </div>
    `;
}

function renderChevron({
    isExpanded,
    isVisible,
}: Readonly<{isExpanded: boolean; isVisible: boolean}>) {
    return html`
        <span
            class=${classMap({
                chevron: true,
                expanded: isExpanded,
                hidden: !isVisible,
            })}
            aria-hidden="true"
        >
            <${ViraIcon.assign({
                icon: LucideChevronRightIcon,
                fitContainer: true,
            })}></${ViraIcon}>
        </span>
    `;
}

function stopPropagation(event: Event) {
    event.stopPropagation();
}

const quoteIcon = createSizedIcon(LucideQuoteIcon, 14);

const quotePopoverDelay = {
    milliseconds: 300,
} as const satisfies AnyDuration;

/** How close the quote button's center may get to the timeline's sides, so it stays in view. */
const quotePopoverEdgeInset = 48;

/** Where the quote button sits, relative to the timeline, and the text it quotes. */
type QuoteSelection = Readonly<{
    text: string;
    top: number;
    left: number;
}>;

function isInAssistantMessage(node: Readonly<Node>, shadowRoot: Readonly<ShadowRoot>) {
    const element = node instanceof Element ? node : node.parentElement;
    return !!element && shadowRoot.contains(element) && !!element.closest('.assistant-entry');
}

/** Annotated because the recursion keeps TypeScript from inferring it. */
function findPreviousText(walker: Readonly<TreeWalker>): Node | undefined {
    const previous = walker.previousNode();
    if (!previous) {
        return undefined;
    }
    return previous.textContent?.trim() ? previous : findPreviousText(walker);
}

/**
 * Triple-clicking a paragraph ends the range at offset 0 of the next block, which is often a work
 * log outside the message, so that end is pulled back to the last text the selection covers.
 */
function readSelectionEnd(range: Readonly<StaticRange>, shadowRoot: ShadowRoot) {
    if (range.endOffset || isInAssistantMessage(range.endContainer, shadowRoot)) {
        return {
            node: range.endContainer,
            offset: range.endOffset,
        };
    }
    const walker = document.createTreeWalker(shadowRoot, NodeFilter.SHOW_TEXT);
    walker.currentNode = range.endContainer;
    const previousText = findPreviousText(walker);
    return previousText
        ? {
              node: previousText,
              offset: previousText.textContent?.length ?? 0,
          }
        : {
              node: range.endContainer,
              offset: range.endOffset,
          };
}

/**
 * Same as `Selection.getComposedRanges`, but also works in Safari 17 through 18.1, which only takes
 * the shadow roots as separate arguments and throws a `TypeError` on the options object.
 */
function readComposedRanges(selection: Readonly<Selection>, shadowRoot: ShadowRoot) {
    try {
        return selection.getComposedRanges({
            shadowRoots: [
                shadowRoot,
            ],
        });
    } catch {
        return (
            selection.getComposedRanges satisfies (...args: never[]) => StaticRange[] as (
                ...shadowRoots: ShadowRoot[]
            ) => StaticRange[]
        ).call(selection, shadowRoot);
    }
}

/** The page's selection when both of its ends are inside assistant messages of this timeline. */
function readQuoteSelection(
    host: Readonly<HTMLElement> & {
        shadowRoot: ShadowRoot;
    },
) {
    const selection = getSelection();
    /**
     * `getRangeAt` and `isCollapsed` don't see into shadow roots (WebKit reports a selection made
     * inside one as collapsed), so only the composed range knows where the selection is.
     */
    const composedRange = selection?.rangeCount
        ? readComposedRanges(selection, host.shadowRoot)[0]
        : undefined;
    if (!selection || !composedRange || composedRange.collapsed) {
        return undefined;
    }
    const end = readSelectionEnd(composedRange, host.shadowRoot);
    const isInAssistantMessages = [
        composedRange.startContainer,
        end.node,
    ].every((node) => isInAssistantMessage(node, host.shadowRoot));
    const text = selection.toString().trim();
    if (!isInAssistantMessages || !text) {
        return undefined;
    }
    const range = document.createRange();
    range.setStart(composedRange.startContainer, composedRange.startOffset);
    range.setEnd(end.node, end.offset);
    const rangeRect = range.getBoundingClientRect();
    const hostRect = host.getBoundingClientRect();
    return {
        text,
        /** Below the selection, where it doesn't cover the iOS selection menu. */
        top: rangeRect.bottom - hostRect.top,
        left: Math.min(
            Math.max(rangeRect.left + rangeRect.width / 2 - hostRect.left, quotePopoverEdgeInset),
            hostRect.width - quotePopoverEdgeInset,
        ),
    };
}

/**
 * A thread's messages and work logs, in timeline order. Selecting text in an assistant message
 * shows a button that emits it as `quoteRequested`.
 */
export const VirAiChatTimeline = defineAppElement<{
    items: ReadonlyArray<Readonly<ThreadItem>>;
    isRunning: boolean;
    backgroundTaskCount: number;
    /** The commands and skills highlighted where a user message mentions them. */
    commands: ReadonlyArray<Readonly<ComposerCommand>> | undefined;
}>()({
    tagName: 'vir-ai-chat-timeline',
    events: {
        /** The selected assistant message text. */
        quoteRequested: defineElementEvent<string>(),
        attachmentOpened: defineElementEvent<Readonly<MessageAttachment>>(),
    },
    state() {
        return {
            /** Work logs and work items the user opened or closed, by key or item id. */
            expanded: {} as Readonly<Record<string, boolean>>,
            quoteSelection: undefined as QuoteSelection | undefined,
            removeSelectionListener: (() => {}) as () => void,
        };
    },
    init({host, updateState}) {
        /**
         * Waits for the selection to stop changing and the pointer to come up, so the button
         * doesn't chase a drag.
         */
        let pendingShow: ReturnType<typeof setTimeout> | undefined;
        let isPointerHeld = false;
        function scheduleShow() {
            clearTimeout(pendingShow);
            if (isPointerHeld) {
                return;
            }
            pendingShow = setTimeout(() => {
                const quoteSelection = readQuoteSelection(host);
                if (quoteSelection) {
                    updateState({
                        quoteSelection,
                    });
                }
            }, quotePopoverDelay.milliseconds);
        }
        function trackSelection() {
            if (host.instanceState.quoteSelection) {
                updateState({
                    quoteSelection: undefined,
                });
            }
            scheduleShow();
        }
        function holdPointer() {
            isPointerHeld = true;
            clearTimeout(pendingShow);
        }
        function releasePointer() {
            isPointerHeld = false;
            scheduleShow();
        }
        document.addEventListener('selectionchange', trackSelection);
        document.addEventListener('pointerdown', holdPointer, true);
        document.addEventListener('pointerup', releasePointer, true);
        document.addEventListener('pointercancel', releasePointer, true);
        updateState({
            removeSelectionListener() {
                clearTimeout(pendingShow);
                document.removeEventListener('selectionchange', trackSelection);
                document.removeEventListener('pointerdown', holdPointer, true);
                document.removeEventListener('pointerup', releasePointer, true);
                document.removeEventListener('pointercancel', releasePointer, true);
            },
        });
    },
    cleanup({state}) {
        state.removeSelectionListener();
    },
    styles: css`
        ${chatMarkdownStyles}
        ${diffLineStyles}

        :host {
            display: block;
            position: relative;
            font-size: 16px;
            color: ${viraThemeByKeys.grey.foreground.body.foreground.value};
        }

        .quote-popover {
            position: absolute;
            z-index: 20;
            margin-top: 6px;
            transform: translateX(-50%);
        }

        ${spinKeyframesCss}

        .spinner {
            flex-shrink: 0;
            color: ${viraThemeByKeys.pink.foreground.body.foreground.value};
            ${spinAnimationCss}
        }

        @keyframes live-shine {
            from {
                background-position:
                    -4.5rem 0,
                    0 0;
            }

            to {
                background-position:
                    calc(100% + 4.5rem) 0,
                    0 0;
            }
        }

        .timeline {
            padding-bottom: 8px;
        }

        .empty {
            margin: 0;
            padding: 32px 0;
            text-align: center;
            color: ${viraThemeByKeys.grey.foreground['non-body'].foreground.value};
        }

        .user-entry {
            display: flex;
            flex-direction: column;
            align-items: flex-end;
            gap: 8px;
            padding-bottom: 16px;

            & .sent-attachments {
                display: flex;
                flex-wrap: wrap;
                justify-content: flex-end;
                gap: 8px;
                max-width: 80%;
            }

            & .user-bubble {
                min-width: 0;
                max-width: 80%;
                box-sizing: border-box;
                padding: 12px;
                border-radius: 16px;
                background-color: ${viraThemeByKeys.grey['behind-fg']['small-body'].background
                    .value};
            }
        }

        .assistant-entry {
            display: flex;
            flex-direction: column;
            gap: 8px;
            min-width: 0;
            padding: 2px 4px 8px;
        }

        .work-images {
            padding: 0 4px 8px;
        }

        .button-reset {
            display: block;
            width: 100%;
            padding: 0;
            border: none;
            background: none;
            font: inherit;
            color: inherit;
            text-align: left;
        }

        .row {
            position: relative;
            box-sizing: border-box;
            width: 100%;
            min-width: 0;
            padding: 2px;
            border-radius: 6px;

            &.grouped {
                padding-block: 0;
            }

            &.interactive {
                cursor: pointer;

                &:hover {
                    background-color: ${viraThemeByKeys.grey['behind-fg']['small-body'].background
                        .value};
                }
            }
        }

        .row:focus-visible,
        .button-reset:focus-visible,
        .tool-calls:focus-visible {
            outline: 2px solid ${viraThemeByKeys.blue.foreground.body.foreground.value};
            outline-offset: -2px;
        }

        .work-line {
            display: flex;
            align-items: center;
            gap: 6px;
            min-width: 0;
            min-height: 24px;
            user-select: none;

            & .icon-cell {
                display: flex;
                flex-shrink: 0;
                align-items: center;
                justify-content: center;
                width: 24px;
                height: 24px;
            }

            & .line-label {
                flex-grow: 1;
                min-width: 0;
                overflow: hidden;
                white-space: nowrap;
                text-overflow: ellipsis;
                color: ${viraThemeByKeys.grey.foreground['non-body'].foreground.value};
            }

            &.wrapped {
                align-items: flex-start;

                & .line-label {
                    white-space: normal;
                }
            }
        }

        .row-icon {
            width: 16px;
            height: 16px;
            opacity: 0.7;
            color: ${viraThemeByKeys.grey.foreground['non-body'].foreground.value};

            &.failed {
                color: ${viraThemeByKeys.red.foreground.body.foreground.value};
            }

            &.destructive {
                opacity: 1;
                color: ${viraThemeByKeys.red.foreground.body.foreground.value};
            }
        }

        .chevron {
            display: flex;
            flex-shrink: 0;
            align-items: center;
            justify-content: center;
            width: 12px;
            height: 12px;
            padding: 2px;
            opacity: 0.7;
            color: ${viraThemeByKeys.grey.foreground['non-body'].foreground.value};
            transition: transform 200ms;

            &.expanded {
                transform: rotate(90deg);
            }

            &.hidden {
                visibility: hidden;
            }
        }

        .live-row {
            width: fit-content;
            max-width: 100%;
            min-width: 0;
            overflow: hidden;
            border-radius: 6px;

            & .live-label {
                display: block;
                overflow: hidden;
                white-space: nowrap;
                text-overflow: ellipsis;
            }
        }

        @media (prefers-reduced-motion: no-preference) {
            & .live-label {
                color: transparent;
                background-image: linear-gradient(
                        to right,
                        transparent,
                        ${viraThemeByKeys.grey.foreground['highest-contrast'].foreground.value},
                        transparent
                    ),
                    linear-gradient(
                        ${viraThemeByKeys.grey.foreground['non-body'].foreground.value},
                        ${viraThemeByKeys.grey.foreground['non-body'].foreground.value}
                    );
                background-size:
                    4.5rem 100%,
                    100% 100%;
                background-repeat: no-repeat;
                background-clip: text;
                animation: live-shine 2.2s steps(30) infinite;
            }
        }

        .work-group-header {
            padding-bottom: 8px;

            &.open {
                padding-bottom: 0;
            }
        }

        .tool-calls {
            max-height: min(18rem, 50dvh);
            overflow-x: hidden;
            overflow-y: auto;
            border-radius: 6px;
        }

        .tool-calls-wrapper {
            padding-bottom: 4px;
        }

        .inspector {
            margin: 2px 0 6px;
            padding-bottom: 8px;
            cursor: auto;
            font-size: 12px;
            user-select: text;

            & .inspector-section {
                display: flex;
                flex-direction: column;
                gap: 8px;
            }

            & .file-header {
                display: flex;
                flex-wrap: wrap;
                align-items: center;
                gap: 8px;

                & .file-title {
                    font-family: monospace;
                    color: ${viraThemeByKeys.grey.foreground['non-body'].foreground.value};
                }

                & .added {
                    color: ${viraThemeByKeys.green.foreground.body.foreground.value};
                }

                & .removed {
                    color: ${viraThemeByKeys.red.foreground.body.foreground.value};
                }
            }

            & .command {
                font-family: monospace;
                font-size: 11px;
                white-space: pre-wrap;
                word-break: break-word;
            }

            & .output.diff-block {
                white-space: normal;
            }

            & .output {
                max-height: 20rem;
                margin: 0;
                overflow: auto;
                font-family: monospace;
                font-size: 11px;
                white-space: pre-wrap;
                word-break: break-word;
                color: ${viraThemeByKeys.grey.foreground['non-body'].foreground.value};
            }
        }

        .markdown-body {
            display: flex;
            flex-direction: column;
            gap: 12px;
            max-height: 24rem;
            margin-inline-start: 28px;
            padding: 4px 2px;
            overflow: auto;
            cursor: auto;
            user-select: text;
        }

        .notice-error {
            padding-bottom: 8px;

            & .line-label {
                font-weight: 500;
                color: ${viraThemeByKeys.red.foreground.body.foreground.value};
            }

            & .notice-detail {
                margin: 0;
                margin-inline-start: 28px;
                padding-block: 4px;
                white-space: pre-wrap;
                word-break: break-word;
                color: ${viraThemeByKeys.grey.foreground.body.foreground.value};
            }
        }

        .notice-separator {
            display: flex;
            align-items: center;
            gap: 12px;
            padding: 4px 0 20px;
            font-size: 12px;
            color: ${viraThemeByKeys.grey.foreground['non-body'].foreground.value};

            & .rule {
                flex-grow: 1;
                height: 1px;
                background-color: ${viraThemeByKeys.grey.foreground.decoration.foreground.value};
            }

            & .notice-text {
                min-width: 0;
                overflow: hidden;
            }
        }

        .working {
            padding-bottom: 6px;

            & .working-inner {
                padding: 4px 0 8px;
                border-bottom: 1px solid
                    ${viraThemeByKeys.grey.foreground.decoration.foreground.value};
            }

            & .working-text {
                display: flex;
                align-items: center;
                gap: 6px;
                height: 24px;
                padding-inline: 4px;
                white-space: nowrap;
                font-variant-numeric: tabular-nums;
                color: ${viraThemeByKeys.grey.foreground['non-body'].foreground.value};
            }
        }
    `,
    render({inputs, state, updateState, dispatch, events}) {
        const timeline = buildTimeline(inputs.items);
        const lastEntry = timeline.at(-1);
        /**
         * Only the last entry shows a spinner, so it stays under everything the turn has shown so
         * far, such as images `show_image` adds while its own tool call is still in progress.
         */
        const isLastEntryLive = !!lastEntry?.items.some((item) => {
            return item.status === ThreadItemStatus.InProgress;
        });
        /**
         * Like T3 Code, a running turn's trailing work log is one line that names the current step
         * or says it's working between steps. Swapping between that line and a separate
         * "Working..." row changes the timeline's height, which jumps everything above it.
         */
        const liveWorkKey =
            inputs.isRunning && timeline.at(-1)?.kind === TimelineEntryKind.Work
                ? timeline.at(-1)?.key
                : undefined;

        function isExpanded(key: string, defaultValue: boolean) {
            return state.expanded[key] ?? defaultValue;
        }

        function toggle(key: string, isOpen: boolean) {
            updateState({
                expanded: {
                    ...state.expanded,
                    [key]: !isOpen,
                },
            });
        }

        function renderInspector(children: HtmlInterpolation) {
            return html`
                <div
                    class="inspector"
                    ${listen('click', stopPropagation)}
                    ${listen('pointerdown', stopPropagation)}
                >
                    ${children}
                </div>
            `;
        }

        function renderFileChangeBody(item: Readonly<ThreadItem>) {
            const counts = countDiffLines(item.text);

            return html`
                <div class="inspector-section">
                    <div class="file-header">
                        <span class="file-title">${item.title}</span>
                        <span>
                            <span class="added">+${counts.additions}</span>
                            <span class="removed">-${counts.deletions}</span>
                        </span>
                    </div>
                    <div class="output diff-block">${renderDiffLines(item.text)}</div>
                </div>
            `;
        }

        function renderToolCallBody(item: Readonly<ThreadItem>) {
            const command = item.kind === ThreadItemKind.Command ? item.title.trim() : '';

            return html`
                <div class="inspector-section">
                    ${command
                        ? html`
                              <div class="command">${command}</div>
                          `
                        : nothing}
                    <pre class="output">${item.text}</pre>
                </div>
            `;
        }

        function renderWorkItem(item: Readonly<ThreadItem>) {
            const display = workItemDisplays[item.kind];
            const isReasoning = item.kind === ThreadItemKind.Reasoning;
            const isFailed = isFailedStatus(item.status);
            const canExpand = !!item.text.trim();
            const isOpen = canExpand && isExpanded(item.id, false);
            const label =
                isReasoning && !isOpen
                    ? item.text.trim().split('\n')[0] || display.describe(item)
                    : display.describe(item);

            const body = isOpen
                ? display.isMarkdown
                    ? html`
                          <div
                              class="markdown-body"
                              ${listen('click', stopPropagation)}
                              ${listen('pointerdown', stopPropagation)}
                          >
                              ${renderChatMarkdown({
                                  text: item.text,
                              })}
                          </div>
                      `
                    : renderInspector(
                          item.kind === ThreadItemKind.FileChange
                              ? renderFileChangeBody(item)
                              : renderToolCallBody(item),
                      )
                : nothing;

            return html`
                <div
                    class=${classMap({
                        row: true,
                        grouped: true,
                        interactive: canExpand,
                    })}
                    role=${canExpand ? 'button' : nothing}
                    tabindex=${canExpand ? 0 : nothing}
                    aria-expanded=${canExpand ? String(isOpen) : nothing}
                    ${listen('click', () => {
                        if (canExpand) {
                            toggle(item.id, isOpen);
                        }
                    })}
                    ${listen('keydown', (event) => {
                        if (
                            canExpand &&
                            event.target === event.currentTarget &&
                            (event.key === 'Enter' || event.key === ' ')
                        ) {
                            event.preventDefault();
                            toggle(item.id, isOpen);
                        }
                    })}
                >
                    ${renderWorkLogLine({
                        icon: renderIcon({
                            icon: display.icon,
                            isFailed,
                        }),
                        label,
                        trailing: renderChevron({
                            isExpanded: isOpen,
                            isVisible: canExpand,
                        }),
                        isWorking: item.status === ThreadItemStatus.InProgress,
                    })}
                    ${body}
                </div>
            `;
        }

        function renderWork(entry: Readonly<TimelineEntry>) {
            const liveItem = entry.items.findLast((item) => {
                return item.status === ThreadItemStatus.InProgress;
            });
            /**
             * Like T3 Code, a group only opens when clicked. Opening it while a step runs and
             * closing it between steps makes the whole timeline jump.
             */
            const isOpen = isExpanded(entry.key, false);
            const firstIcon =
                workItemDisplays[entry.items[0]?.kind ?? ThreadItemKind.ToolCall].icon;

            const header = html`
                <button
                    type="button"
                    class=${classMap({
                        'button-reset': true,
                        row: true,
                        interactive: true,
                    })}
                    aria-expanded=${String(isOpen)}
                    ${listen('click', () => {
                        toggle(entry.key, isOpen);
                    })}
                >
                    ${(liveItem && entry.key === lastEntry?.key) || entry.key === liveWorkKey
                        ? html`
                              <div class="live-row">
                                  ${renderWorkLogLine({
                                      icon: renderIcon({
                                          icon: liveItem
                                              ? workItemDisplays[liveItem.kind].icon
                                              : firstIcon,
                                      }),
                                      label: html`
                                          <span class="live-label">
                                              ${liveItem
                                                  ? liveItem.kind === ThreadItemKind.Reasoning
                                                      ? liveItem.text.trim().split('\n').at(-1) ||
                                                        workItemDisplays[liveItem.kind].describe(
                                                            liveItem,
                                                        )
                                                      : workItemDisplays[liveItem.kind].describe(
                                                            liveItem,
                                                        )
                                                  : 'Working...'}
                                          </span>
                                      `,
                                      trailing: nothing,
                                      isWorking: true,
                                  })}
                              </div>
                          `
                        : renderWorkLogLine({
                              icon: renderIcon({
                                  icon: firstIcon,
                              }),
                              label: summarizeWork(entry.items),
                              trailing: nothing,
                          })}
                </button>
            `;

            return html`
                ${entry.items.some((item) => item.imagePaths.length)
                    ? html`
                          <div class="work-images">
                              ${renderChatImages(entry.items.flatMap((item) => item.imagePaths))}
                          </div>
                      `
                    : nothing}
                <div
                    class=${classMap({
                        'work-group-header': true,
                        open: isOpen,
                    })}
                >
                    ${header}
                </div>
                ${isOpen
                    ? html`
                          <div class="tool-calls-wrapper">
                              <div
                                  class="tool-calls"
                                  tabindex="0"
                                  role="region"
                                  aria-label="Tool calls"
                              >
                                  ${entry.items.map(renderWorkItem)}
                              </div>
                          </div>
                      `
                    : nothing}
            `;
        }

        const entryRenderers: Record<
            TimelineEntryKind,
            (entry: Readonly<TimelineEntry>) => HtmlInterpolation
        > = {
            [TimelineEntryKind.UserMessage](entry) {
                return entry.items.map((item) => {
                    const message = splitMessageAttachments(item.text);
                    return html`
                        <div class="user-entry" data-turn-id=${item.id}>
                            <h3 hidden>You</h3>
                            ${message.attachments.length
                                ? html`
                                      <div class="sent-attachments">
                                          ${message.attachments.map((attachment) => {
                                              return html`
                                                  <${VirAiChatSentAttachment.assign({
                                                      attachment,
                                                  })}
                                                      ${listen(
                                                          VirAiChatSentAttachment.events.opened,
                                                          () => {
                                                              dispatch(
                                                                  new events.attachmentOpened({
                                                                      detail: attachment,
                                                                  }),
                                                              );
                                                          },
                                                      )}
                                                  ></${VirAiChatSentAttachment}>
                                              `;
                                          })}
                                      </div>
                                  `
                                : nothing}
                            ${message.text
                                ? html`
                                      <div class="user-bubble">
                                          ${renderChatMarkdown({
                                              text: message.text,
                                              hasLineBreaks: true,
                                              marks: splitComposerCommandMentions({
                                                  text: message.text,
                                                  commands: inputs.commands || [],
                                              }).flatMap((part) => {
                                                  return part.command
                                                      ? [
                                                            {
                                                                text: part.text,
                                                                color: findCommandMentionColor(
                                                                    part.command,
                                                                ).cssText,
                                                            },
                                                        ]
                                                      : [];
                                              }),
                                          })}
                                      </div>
                                  `
                                : nothing}
                        </div>
                    `;
                });
            },
            [TimelineEntryKind.AssistantMessage](entry) {
                return entry.items.map((item) => {
                    return html`
                        <div class="assistant-entry">
                            ${item.text
                                ? renderChatMarkdown({
                                      text: item.text,
                                  })
                                : nothing}
                            ${renderChatImages(item.imagePaths)}
                        </div>
                    `;
                });
            },
            [TimelineEntryKind.Work]: renderWork,
            [TimelineEntryKind.Notice](entry) {
                return entry.items.map((item): TemplateResult => {
                    const message = item.title || item.text;
                    const detail = item.title && item.text !== item.title ? item.text : '';

                    return isFailedStatus(item.status)
                        ? html`
                              <div class="notice-error">
                                  <div class="row">
                                      <div class="work-line wrapped">
                                          <span class="icon-cell">
                                              <${ViraIcon.assign({
                                                  icon: LucideCircleAlertIcon,
                                                  fitContainer: true,
                                              })}
                                                  class="row-icon destructive"
                                              ></${ViraIcon}>
                                          </span>
                                          <span class="line-label">${message}</span>
                                      </div>
                                      ${detail
                                          ? html`
                                                <p class="notice-detail">${detail}</p>
                                            `
                                          : nothing}
                                  </div>
                              </div>
                          `
                        : html`
                              <div class="notice-separator" role="separator" ${tooltip(item.text)}>
                                  <span class="rule"></span>
                                  <span class="notice-text">${message}</span>
                                  <span class="rule"></span>
                              </div>
                          `;
                });
            },
        };

        return html`
            <div
                class="timeline"
                ${listen(VirAiChatLocalImage.events.opened, (event) => {
                    dispatch(
                        new events.attachmentOpened({
                            detail: event.detail,
                        }),
                    );
                })}
            >
                ${timeline.length || inputs.isRunning
                    ? nothing
                    : html`
                          <p class="empty">Send a message to start the conversation.</p>
                      `}
                ${timeline.map((entry) => entryRenderers[entry.kind](entry))}
                ${(inputs.isRunning && !isLastEntryLive && !liveWorkKey) ||
                (!inputs.isRunning && inputs.backgroundTaskCount)
                    ? html`
                          <div class="working">
                              <div class="working-inner">
                                  <div class="working-text">
                                      ${renderSpinner()}
                                      ${inputs.backgroundTaskCount
                                          ? `Waiting on ${inputs.backgroundTaskCount} background ${inputs.backgroundTaskCount === 1 ? 'task' : 'tasks'}...`
                                          : 'Working...'}
                                  </div>
                              </div>
                          </div>
                      `
                    : nothing}
            </div>
            ${state.quoteSelection
                ? html`
                      <div
                          class="quote-popover"
                          style=${css`
                              top: ${state.quoteSelection.top}px;
                              left: ${state.quoteSelection.left}px;
                          `}
                      >
                          <${ViraButton.assign({
                              text: 'Quote',
                              icon: quoteIcon,
                              buttonSize: ViraSize.Small,
                              color: ViraColorVariant.Neutral,
                          })}
                              ${listen('pointerdown', (event) => {
                                  /**
                                   * Acts on press: a tap on iOS clears the selection before
                                   * `click`, which removes this button first.
                                   */
                                  event.preventDefault();
                                  const text = state.quoteSelection?.text;
                                  if (!text) {
                                      return;
                                  }
                                  getSelection()?.removeAllRanges();
                                  dispatch(
                                      new events.quoteRequested({
                                          detail: text,
                                      }),
                                  );
                              })}
                          ></${ViraButton}>
                      </div>
                  `
                : nothing}
        `;
    },
});
