import {defineAppElement} from '@agent-storm/core/frontend';
import {
    classMap,
    css,
    html,
    listen,
    nothing,
    type HtmlInterpolation,
    type TemplateResult,
} from 'element-vir';
import {
    LucideChevronRightIcon,
    LucideCircleAlertIcon,
    tooltip,
    ViraIcon,
    viraThemeByKeys,
    type ViraIconSvg,
} from 'vira';
import {ThreadItemKind, ThreadItemStatus, type ThreadItem} from '../../build-v2-api.js';
import {splitMessageAttachments} from '../../util/message-attachments.js';
import {
    buildTimeline,
    summarizeWork,
    TimelineEntryKind,
    type TimelineEntry,
} from '../../util/thread-timeline.js';
import {countDiffLines, diffLineStyles, renderDiffLines} from './diff-lines.js';
import {chatMarkdownStyles, renderChatMarkdown} from './markdown-styles.js';
import {workItemDisplays} from './thread-display.js';
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

function renderWorkLogLine({
    icon,
    label,
    trailing,
}: Readonly<{
    icon: HtmlInterpolation;
    label: HtmlInterpolation;
    trailing: HtmlInterpolation;
}>) {
    return html`
        <div class="work-line">
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

/** A thread's messages and work logs, in timeline order. */
export const VirAiChatTimeline = defineAppElement<{
    items: ReadonlyArray<Readonly<ThreadItem>>;
    isRunning: boolean;
}>()({
    tagName: 'vir-ai-chat-timeline',
    state() {
        return {
            /** Work logs and work items the user opened or closed, by key or item id. */
            expanded: {} as Readonly<Record<string, boolean>>,
        };
    },
    styles: css`
        ${chatMarkdownStyles}
        ${diffLineStyles}

        :host {
            display: block;
            color: ${viraThemeByKeys.grey.foreground.body.foreground.value};
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
            font-size: 14px;
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
            min-width: 0;
            padding: 2px 4px 8px;
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
                height: 24px;
                padding-inline: 4px;
                font-size: 14px;
                white-space: nowrap;
                font-variant-numeric: tabular-nums;
                color: ${viraThemeByKeys.grey.foreground['non-body'].foreground.value};
            }
        }
    `,
    render({inputs, state, updateState}) {
        const timeline = buildTimeline(inputs.items);
        const hasLiveItem = inputs.items.some((item) => {
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
                    ${liveItem || entry.key === liveWorkKey
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
                                                  })}></${VirAiChatSentAttachment}>
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
                            ${renderChatMarkdown({
                                text: item.text,
                            })}
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
            <div class="timeline">
                ${timeline.length || inputs.isRunning
                    ? nothing
                    : html`
                          <p class="empty">Send a message to start the conversation.</p>
                      `}
                ${timeline.map((entry) => entryRenderers[entry.kind](entry))}
                ${inputs.isRunning && !hasLiveItem && !liveWorkKey
                    ? html`
                          <div class="working">
                              <div class="working-inner">
                                  <div class="working-text">Working...</div>
                              </div>
                          </div>
                      `
                    : nothing}
            </div>
        `;
    },
});
