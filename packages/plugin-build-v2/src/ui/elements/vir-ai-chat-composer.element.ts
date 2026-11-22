import {
    defineAppElement,
    matchesShortcut,
    spinAnimationCss,
    spinKeyframesCss,
    withShortcutHint,
    type KeyboardShortcut,
} from '@agent-storm/core/frontend';
import {assertWrap} from '@augment-vir/assert';
import {extractEventTarget} from '@augment-vir/web';
import {classMap, css, defineElementEvent, html, listen, nothing} from 'element-vir';
import {
    createAnchoredPopoverStyles,
    createSizedIcon,
    LucideArchiveIcon,
    LucideArrowUpIcon,
    LucideGitBranchPlusIcon,
    LucideLoaderCircleIcon,
    LucidePlusIcon,
    LucideSquareIcon,
    LucideXIcon,
    popover,
    PopoverManager,
    tooltip,
    ViraButton,
    ViraColorVariant,
    ViraEmphasis,
    ViraIcon,
    viraThemeByKeys,
} from 'vira';
import {
    type AiProvider,
    type ComposerCommand,
    type ReasoningEffort,
    type RuntimeMode,
} from '../../build-v2-api.js';
import {
    detectComposerTrigger,
    insertComposerCommand,
    listComposerMenuCommands,
    splitComposerCommandMentions,
} from '../../util/composer-commands.js';
import {type composerShortcutActions} from '../../util/composer-shortcuts.js';
import {collectDroppedFiles} from '../../util/file-drop.js';
import {toMessageAttachment, type MessageAttachment} from '../../util/message-attachments.js';
import {attachmentCardStyles, renderAttachmentCardContent} from './attachment-card.js';
import {findCommandMentionColor, VirAiChatCommandMenu} from './vir-ai-chat-command-menu.element.js';
import {VirAiChatMcp} from './vir-ai-chat-mcp.element.js';
import {
    VirAiChatModelPicker,
    type ModelSelection,
    type ProviderModelList,
} from './vir-ai-chat-model-picker.element.js';
import {VirAiChatPermissions} from './vir-ai-chat-permissions.element.js';

const sendIcon = createSizedIcon(LucideArrowUpIcon, 16);
const stopIcon = createSizedIcon(LucideSquareIcon, 12);
const archiveIcon = createSizedIcon(LucideArchiveIcon, 16);
const worktreeIcon = createSizedIcon(LucideGitBranchPlusIcon, 16);
const attachIcon = createSizedIcon(LucidePlusIcon, 16);
const removeIcon = createSizedIcon(LucideXIcon, 12);
const uploadingIcon = createSizedIcon(LucideLoaderCircleIcon, 20);

/** A paste at least this long becomes a text file attachment instead of landing in the box. */
const minPastedAttachmentLength = 4000;

/** A file attached to the unsent message, shown as a card above the message box. */
export type ComposerAttachment = {
    id: string;
    name: string;
    /** Short label on a non-image card, such as the file's extension. Empty for none. */
    tag: string;
    /** Where the upload landed. Unset while it uploads. */
    path: string | undefined;
    /** A data URL, set for images to show as a thumbnail. */
    imageUrl: string | undefined;
    /** The start of the text, set for pasted text to show instead of the file name. */
    textPreview: string | undefined;
};

/**
 * The message box under a chat. Its `shortcuts` send, send from a new worktree when that button is
 * shown, and archive; the worktree one sends normally when that button isn't shown. While the
 * thread runs and the box is empty, Stop takes the send button's place. With a `questionAction`,
 * the box holds a custom answer and the send button moves through the questions instead. Pasted
 * files are emitted as `filesPicked`, and a long paste as `textPasted`, rather than typed into the
 * box. A `/` or `$` word at the caret opens a menu of `commands` above the box, and asks for them
 * with `commandsRequested`.
 */
export const VirAiChatComposer = defineAppElement<{
    text: string;
    /** Messages already sent, oldest first, that Up and Down step through like a shell history. */
    history: ReadonlyArray<string>;
    placeholder: string;
    isRunning: boolean;
    /** While a send or stop is in flight. */
    isBusy: boolean;
    /** Shows the archive button beside send. */
    canArchive: boolean;
    /** Shows a button beside send that sends the message from a new worktree. */
    canSendInWorktree: boolean;
    /** Shown above the message box. A message with only attachments can still be sent. */
    attachments: ReadonlyArray<Readonly<ComposerAttachment>>;
    providerModels: Readonly<Partial<Record<AiProvider, ProviderModelList>>>;
    provider: AiProvider;
    /** Empty for the provider's default model. */
    model: string;
    /** Unset for the model's default effort. */
    effort: ReasoningEffort | undefined;
    /** Unset for standard speed. */
    speedTier: string | undefined;
    runtimeMode: RuntimeMode;
    /**
     * The thread whose MCP servers the MCP chip lists, which sending `/mcp` opens too. Unset hides
     * the chip and sends `/mcp` to the provider.
     */
    mcpThreadId: string | undefined;
    /** The provider's commands and skills, for the `/` and `$` menu. Unset while they load. */
    commands: ReadonlyArray<Readonly<ComposerCommand>> | undefined;
    /** Focuses the message box each time this turns on. */
    isShown: boolean;
    shortcuts: Readonly<
        Record<keyof typeof composerShortcutActions, ReadonlyArray<KeyboardShortcut>>
    >;
    /** Set while a question waits, to label the send button and submit even with an empty box. */
    questionAction:
        | Readonly<{
              label: string;
              isEnabled: boolean;
          }>
        | undefined;
}>()({
    tagName: 'vir-ai-chat-composer',
    events: {
        textChange: defineElementEvent<string>(),
        submitted: defineElementEvent<string>(),
        worktreeSubmitted: defineElementEvent<string>(),
        stopRequested: defineElementEvent<void>(),
        archiveRequested: defineElementEvent<void>(),
        modelChange: defineElementEvent<ModelSelection>(),
        runtimeModeChange: defineElementEvent<RuntimeMode>(),
        filesPicked: defineElementEvent<ReadonlyArray<File>>(),
        textPasted: defineElementEvent<string>(),
        /** The removed attachment's id. */
        attachmentRemoved: defineElementEvent<string>(),
        /** An uploaded attachment was clicked. */
        attachmentOpened: defineElementEvent<Readonly<MessageAttachment>>(),
        /** The command menu opened, so `commands` should be read again. */
        commandsRequested: defineElementEvent<void>(),
    },
    state() {
        return {
            wasShown: false,
            /** The `history` entry shown in the box. Unset while not stepping through history. */
            historyIndex: undefined as number | undefined,
            /** The unsent text to put back when Down steps past the newest `history` entry. */
            historyDraft: '',
            isFocused: false,
            isMcpOpen: false,
            /** Opens the command menu above the message box while there's a menu trigger. */
            commandMenuPopover: new PopoverManager(),
            caret: 0,
            /** The `rangeStart` of the menu trigger the user closed the menu on. */
            dismissedTriggerStart: undefined as number | undefined,
            /** The highlighted menu row, for the trigger word as `menuKey` names it. */
            activeMenuRow: {
                menuKey: '',
                index: 0,
            },
        };
    },
    styles: css`
        ${spinKeyframesCss}

        :host {
            display: block;
            position: relative;
            z-index: 30;
        }

        ${createAnchoredPopoverStyles({
            selector: css`.command-menu-popover`,
            fallbacks: [
                {
                    name: 'vir-ai-chat-command-menu-below',
                    styles: css``,
                    flipBlock: true,
                },
            ],
        })}

        .command-menu-popover {
            position-area: block-start;
            width: anchor-size(width);
            margin-bottom: 6px;
        }

        .composer {
            display: flex;
            flex-direction: column;
            width: 100%;
            box-sizing: border-box;
            border-radius: 16px;
            border: 1px solid ${viraThemeByKeys.grey.foreground.decoration.foreground.value};
            background-color: ${viraThemeByKeys.grey['behind-bg'].body.foreground.value};
            color: ${viraThemeByKeys.grey.foreground.body.foreground.value};

            &:focus-within {
                border-color: ${viraThemeByKeys.grey.foreground['non-body'].foreground.value};
            }
        }

        .attachments {
            display: flex;
            gap: 8px;
            padding: 12px 12px 0;
            overflow-x: auto;
        }

        ${attachmentCardStyles}

        .attachment {
            &.uploaded {
                cursor: pointer;
            }

            &.uploading > :not(.status, .remove) {
                opacity: 0.4;
            }

            & .status {
                position: absolute;
                inset: 0;
                display: flex;
                align-items: center;
                justify-content: center;

                & ${ViraIcon} {
                    ${spinAnimationCss}
                }
            }

            & .remove {
                position: absolute;
                top: 4px;
                right: 4px;
                width: 22px;
                height: 22px;
                opacity: 0;
                ${ViraButton.cssVars['vira-button-border-radius'].name}: 50%;
            }

            &:hover .remove,
            &:focus-within .remove {
                opacity: 1;
            }

            @media (hover: none) {
                & .remove {
                    opacity: 1;
                }
            }
        }

        .editor {
            position: relative;
        }

        textarea,
        .highlights {
            box-sizing: border-box;
            width: 100%;
            padding: 14px 16px 8px;
            font: inherit;
            font-size: 14px;
            white-space: pre-wrap;
            overflow-wrap: break-word;
            overflow-y: auto;
        }

        .highlights {
            position: absolute;
            inset: 0;
            color: transparent;
            pointer-events: none;

            & mark {
                color: transparent;
                border-radius: 4px;
            }
        }

        textarea {
            position: relative;
            display: block;
            field-sizing: content;
            min-height: 3.5em;
            max-height: 208px;
            color: inherit;
            background: none;
            border: none;
            outline: none;
            resize: none;

            &::placeholder {
                color: ${viraThemeByKeys.grey.foreground.placeholder.foreground.value};
            }
        }

        .footer {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 8px;
            padding: 0 8px 8px;
        }

        .controls {
            display: flex;
            align-items: center;
            gap: 2px;
            min-width: 0;

            & ${VirAiChatModelPicker} {
                flex-shrink: 1;
            }
        }

        .actions {
            display: flex;
            flex-shrink: 0;
            align-items: center;
            gap: 12px;
        }

        .action {
            flex-shrink: 0;
            width: 32px;
            height: 32px;
            ${ViraButton.cssVars['vira-button-border-radius'].name}: 50%;

            &.labeled {
                width: auto;
                ${ViraButton.cssVars['vira-button-border-radius'].name}: 16px;
            }

            &.stop {
                ${ViraButton.cssVars['vira-button-border-width'].name}: 0;
                ${ViraButton.cssVars['vira-button-disabled-text-color'].name}: ${viraThemeByKeys
                    .grey.foreground.placeholder.foreground.value};
                ${ViraButton.cssVars['vira-button-disabled-background-color']
                    .name}: ${viraThemeByKeys.grey['behind-fg']['small-body'].background.value};
                ${ViraButton.cssVars['vira-button-text-color'].name}: ${viraThemeByKeys.red[
                    'on-self'
                ].body.foreground.value};
                ${ViraButton.cssVars['vira-button-background-color'].name}: ${viraThemeByKeys.red[
                    'on-self'
                ].body.background.value};
                ${ViraButton.cssVars['vira-button-hover-text-color'].name}: ${viraThemeByKeys.red[
                    'on-self'
                ].body.foreground.value};
                ${ViraButton.cssVars['vira-button-hover-background-color'].name}: ${viraThemeByKeys
                    .red['on-self'].body.background.value};
                ${ViraButton.cssVars['vira-button-active-text-color'].name}: ${viraThemeByKeys.red[
                    'on-self'
                ].body.foreground.value};
                ${ViraButton.cssVars['vira-button-active-background-color'].name}: ${viraThemeByKeys
                    .red['on-self'].body.background.value};
            }
        }
    `,
    render({inputs, state, updateState, dispatch, events, host}) {
        if (inputs.isShown !== state.wasShown) {
            updateState({
                wasShown: inputs.isShown,
            });
            if (inputs.isShown) {
                requestAnimationFrame(() => {
                    host.shadowRoot.querySelector('textarea')?.focus();
                });
            }
        }
        const hasContent = !!inputs.text.trim() || !!inputs.attachments.length;
        const canSend = (inputs.questionAction?.isEnabled ?? hasContent) && !inputs.isBusy;
        const showsStop = !inputs.questionAction && inputs.isRunning && !hasContent;

        function stop() {
            if (inputs.isBusy) {
                return;
            }
            dispatch(
                new events.stopRequested({
                    detail: undefined,
                }),
            );
        }

        /**
         * Whether the caret sits on the box's top (or bottom) visual line, counting lines that soft
         * wrap. Measures a hidden copy of the box with the text up to the caret: the caret is on
         * the top line when that text is no taller than an empty box, and on the bottom line when
         * it is as tall as the whole text.
         */
        function isCaretOnEdgeLine({
            textarea,
            isTop,
        }: Readonly<{
            textarea: HTMLTextAreaElement;
            isTop: boolean;
        }>) {
            const measurer = document.createElement('textarea');
            measurer.setAttribute('aria-hidden', 'true');
            measurer.tabIndex = -1;
            measurer.style.cssText = [
                'position: absolute',
                'visibility: hidden',
                'pointer-events: none',
                'field-sizing: fixed',
                'min-height: 0',
                'max-height: none',
                'height: 0',
                `width: ${textarea.offsetWidth}px`,
            ].join(';');
            textarea.after(measurer);

            function measureHeight(text: string) {
                measurer.value = text;
                return measurer.scrollHeight;
            }

            const beforeCaretHeight = measureHeight(
                textarea.value.slice(0, textarea.selectionStart),
            );
            const edgeHeight = measureHeight(isTop ? '' : textarea.value);
            measurer.remove();
            return beforeCaretHeight === edgeHeight;
        }

        /**
         * Swaps the box's text for the previous or next `history` entry once the caret sits on the
         * first or last line, like Up and Down in the Claude Code CLI. Returns whether it did.
         */
        function stepHistory({
            textarea,
            isOlder,
        }: Readonly<{
            textarea: HTMLTextAreaElement;
            isOlder: boolean;
        }>) {
            const caret = textarea.selectionStart;
            if (
                inputs.questionAction ||
                textarea.selectionEnd !== caret ||
                !isCaretOnEdgeLine({
                    textarea,
                    isTop: isOlder,
                })
            ) {
                return false;
            }
            const nextIndex = (state.historyIndex ?? inputs.history.length) + (isOlder ? -1 : 1);
            if (nextIndex < 0 || nextIndex > inputs.history.length) {
                return false;
            }
            const isDraft = nextIndex === inputs.history.length;
            const text = isDraft ? state.historyDraft : inputs.history[nextIndex] || '';
            updateState({
                historyIndex: isDraft ? undefined : nextIndex,
                historyDraft: state.historyIndex == undefined ? textarea.value : state.historyDraft,
            });
            /**
             * Set here so the caret can move now. The `.value` binding then writes the same text,
             * which leaves the caret alone.
             */
            textarea.value = text;
            const caretTarget = isOlder ? 0 : text.length;
            textarea.setSelectionRange(caretTarget, caretTarget);
            dispatch(
                new events.textChange({
                    detail: text,
                }),
            );
            return true;
        }

        function findTrigger({
            text,
            caret,
            isFocused,
        }: Readonly<{
            text: string;
            caret: number;
            isFocused: boolean;
        }>) {
            /** Up and Down step through history then, which an open menu would take over. */
            const isSteppingHistory = state.historyIndex != undefined;
            const found =
                isFocused && !inputs.questionAction && !isSteppingHistory
                    ? detectComposerTrigger({
                          text,
                          cursor: caret,
                      })
                    : undefined;
            return {
                trigger: found,
                isDismissed: !!found && found.rangeStart === state.dismissedTriggerStart,
            };
        }

        const caretTrigger = findTrigger({
            text: inputs.text,
            caret: state.caret,
            isFocused: state.isFocused,
        });
        const trigger = caretTrigger.isDismissed ? undefined : caretTrigger.trigger;
        const menuCommands =
            trigger && inputs.commands
                ? listComposerMenuCommands({
                      commands: inputs.commands,
                      trigger,
                  })
                : undefined;
        const menuKey = trigger ? `${trigger.rangeStart}:${trigger.kind}:${trigger.query}` : '';
        const activeMenuIndex =
            state.activeMenuRow.menuKey === menuKey
                ? Math.min(state.activeMenuRow.index, (menuCommands?.length || 1) - 1)
                : 0;

        /** Follows the caret, and asks for the commands again each time the menu opens. */
        function trackCaret(textarea: Readonly<HTMLTextAreaElement>, isFocused: boolean) {
            const caret = textarea.selectionStart;
            const next = findTrigger({
                text: textarea.value,
                caret,
                isFocused,
            });
            if (next.trigger && !next.isDismissed && !trigger) {
                dispatch(
                    new events.commandsRequested({
                        detail: undefined,
                    }),
                );
            }
            const dismissedTriggerStart = next.isDismissed
                ? state.dismissedTriggerStart
                : undefined;
            if (
                caret !== state.caret ||
                isFocused !== state.isFocused ||
                dismissedTriggerStart !== state.dismissedTriggerStart
            ) {
                updateState({
                    caret,
                    isFocused,
                    dismissedTriggerStart,
                });
            }
        }

        function pickCommand(command: Readonly<ComposerCommand>) {
            if (!trigger) {
                return;
            }
            const inserted = insertComposerCommand({
                text: inputs.text,
                trigger,
                command,
            });
            const textarea = host.shadowRoot.querySelector('textarea');
            /**
             * Setting the box's value before the new `text` comes back keeps the caret where it's
             * put here: the binding then sets the same value, which doesn't move the caret.
             */
            if (textarea) {
                textarea.value = inserted.text;
                textarea.focus();
                textarea.setSelectionRange(inserted.cursor, inserted.cursor);
            }
            updateState({
                caret: inserted.cursor,
            });
            dispatch(
                new events.textChange({
                    detail: inserted.text,
                }),
            );
        }

        function moveMenuRow(offset: number) {
            const count = menuCommands?.length || 0;
            updateState({
                activeMenuRow: {
                    menuKey,
                    index: (activeMenuIndex + offset + count) % count,
                },
            });
        }

        function pickActiveCommand() {
            const command = menuCommands?.[activeMenuIndex];
            if (command) {
                pickCommand(command);
            }
        }

        /** Keys the open menu takes from the message box. The row keys need a row to act on. */
        const menuKeyActions: Readonly<Partial<Record<string, () => void>>> = {
            ...(menuCommands?.length
                ? {
                      ArrowDown() {
                          moveMenuRow(1);
                      },
                      ArrowUp() {
                          moveMenuRow(-1);
                      },
                      Enter: pickActiveCommand,
                      Tab: pickActiveCommand,
                  }
                : {}),
            Escape() {
                updateState({
                    dismissedTriggerStart: trigger?.rangeStart,
                });
            },
        };

        function submit({isInWorktree}: Readonly<{isInWorktree: boolean}>) {
            if (!canSend) {
                return;
            }
            updateState({
                historyIndex: undefined,
            });
            const detail = inputs.text.trim();
            /** Claude Code answers `/mcp` with only a count of its servers. */
            if (
                inputs.mcpThreadId &&
                !isInWorktree &&
                !inputs.questionAction &&
                !inputs.attachments.length &&
                detail === '/mcp'
            ) {
                dispatch(
                    new events.textChange({
                        detail: '',
                    }),
                );
                updateState({
                    isMcpOpen: true,
                });
                return;
            }
            dispatch(
                isInWorktree
                    ? new events.worktreeSubmitted({
                          detail,
                      })
                    : new events.submitted({
                          detail,
                      }),
            );
        }

        function archive() {
            if (!inputs.canArchive || inputs.isBusy) {
                return;
            }
            dispatch(
                new events.archiveRequested({
                    detail: undefined,
                }),
            );
        }

        const attachmentCards = inputs.attachments.map((attachment) => {
            return html`
                <div
                    class=${classMap({
                        attachment: true,
                        image: !!attachment.imageUrl,
                        uploading: !attachment.path,
                        uploaded: !!attachment.path,
                    })}
                    ${tooltip(attachment.name)}
                    ${listen('click', () => {
                        if (attachment.path) {
                            dispatch(
                                new events.attachmentOpened({
                                    detail: toMessageAttachment(attachment.path),
                                }),
                            );
                        }
                    })}
                >
                    ${renderAttachmentCardContent(attachment)}
                    ${attachment.path
                        ? nothing
                        : html`
                              <div class="status">
                                  <${ViraIcon.assign({
                                      icon: uploadingIcon,
                                  })}></${ViraIcon}>
                              </div>
                          `}
                    <${ViraButton.assign({
                        icon: removeIcon,
                        color: ViraColorVariant.Neutral,
                    })}
                        class="remove"
                        aria-label="Remove ${attachment.name}"
                        ${listen('click', (event) => {
                            /** Keeps the card under the button from opening the attachment. */
                            event.stopPropagation();
                            dispatch(
                                new events.attachmentRemoved({
                                    detail: attachment.id,
                                }),
                            );
                        })}
                    ></${ViraButton}>
                </div>
            `;
        });

        /**
         * Painted behind the message box, which has no background, so the tags' colors show through
         * it. The highlights keep whitespace like the box does, so the `<mark>` template must not
         * be reformatted onto its own lines.
         */
        const highlights = [
            ...splitComposerCommandMentions({
                text: inputs.text,
                commands: inputs.commands || [],
            }).map((part) => {
                if (!part.command) {
                    return part.text;
                }
                const color = findCommandMentionColor(part.command);
                const style = css`
                    background-color: ${color};
                    box-shadow: 0 0 0 2px ${color};
                `;
                // prettier-ignore
                return html`<mark style=${style}>${part.text}</mark>`;
            }),
            /** Gives a trailing newline its own line, as the message box does. */
            ' ',
        ];

        return html`
            ${trigger
                ? html`
                      <div class="command-menu-popover" popover="manual">
                          <${VirAiChatCommandMenu.assign({
                              commands: menuCommands,
                              triggerKind: trigger.kind,
                              activeIndex: activeMenuIndex,
                          })}
                              ${listen('mousedown', (event) => {
                                  /** Keeps the message box focused, which keeps the menu open. */
                                  event.preventDefault();
                              })}
                              ${listen(VirAiChatCommandMenu.events.commandPicked, (event) => {
                                  pickCommand(event.detail);
                              })}
                              ${listen(VirAiChatCommandMenu.events.commandHovered, (event) => {
                                  updateState({
                                      activeMenuRow: {
                                          menuKey,
                                          index: event.detail,
                                      },
                                  });
                              })}
                          ></${VirAiChatCommandMenu}>
                      </div>
                  `
                : nothing}
            <div
                class="composer"
                ${popover(state.commandMenuPopover, {
                    trigger: !!trigger,
                    getPopover() {
                        return assertWrap.instanceOf(
                            host.shadowRoot.querySelector('.command-menu-popover'),
                            HTMLElement,
                        );
                    },
                })}
                ${listen('keydown', (event) => {
                    if (
                        !event.repeat &&
                        matchesShortcut({
                            event,
                            shortcuts: inputs.shortcuts.archive,
                        })
                    ) {
                        event.preventDefault();
                        archive();
                    }
                })}
            >
                ${inputs.attachments.length
                    ? html`
                          <div class="attachments">${attachmentCards}</div>
                      `
                    : nothing}
                <div class="editor">
                    <div class="highlights" aria-hidden="true">${highlights}</div>
                    <textarea
                        rows="2"
                        data-testid="composer-editor"
                        aria-label=${inputs.questionAction ? 'Your own answer' : 'Message'}
                        placeholder=${inputs.placeholder}
                        .value=${inputs.text}
                        ${listen('input', (event) => {
                            const textarea = extractEventTarget(event, HTMLTextAreaElement);
                            updateState({
                                historyIndex: undefined,
                            });
                            trackCaret(textarea, true);
                            dispatch(
                                new events.textChange({
                                    detail: textarea.value,
                                }),
                            );
                        })}
                        ${listen('scroll', (event) => {
                            const highlightsElement = host.shadowRoot.querySelector('.highlights');
                            if (highlightsElement) {
                                highlightsElement.scrollTop = extractEventTarget(
                                    event,
                                    HTMLTextAreaElement,
                                ).scrollTop;
                            }
                        })}
                        ${listen('click', (event) => {
                            trackCaret(extractEventTarget(event, HTMLTextAreaElement), true);
                        })}
                        ${listen('keyup', (event) => {
                            trackCaret(extractEventTarget(event, HTMLTextAreaElement), true);
                        })}
                        ${listen('focus', (event) => {
                            trackCaret(extractEventTarget(event, HTMLTextAreaElement), true);
                        })}
                        ${listen('blur', (event) => {
                            trackCaret(extractEventTarget(event, HTMLTextAreaElement), false);
                        })}
                        ${listen('paste', (event) => {
                            if (inputs.questionAction || !event.clipboardData) {
                                return;
                            }
                            const files = collectDroppedFiles(event.clipboardData);
                            if (files.length) {
                                event.preventDefault();
                                dispatch(
                                    new events.filesPicked({
                                        detail: files,
                                    }),
                                );
                                return;
                            }
                            const pasted = event.clipboardData.getData('text/plain');
                            if (pasted.length < minPastedAttachmentLength) {
                                return;
                            }
                            event.preventDefault();
                            dispatch(
                                new events.textPasted({
                                    detail: pasted,
                                }),
                            );
                        })}
                        ${listen('keydown', (event) => {
                            if (event.isComposing) {
                                return;
                            }
                            const hasModifier =
                                event.shiftKey || event.metaKey || event.ctrlKey || event.altKey;
                            const menuKeyAction =
                                trigger && !hasModifier ? menuKeyActions[event.key] : undefined;
                            if (menuKeyAction) {
                                event.preventDefault();
                                event.stopPropagation();
                                menuKeyAction();
                                return;
                            } else if (
                                matchesShortcut({
                                    event,
                                    shortcuts: inputs.shortcuts.interrupt,
                                })
                            ) {
                                if (inputs.isRunning) {
                                    event.preventDefault();
                                    stop();
                                }
                                return;
                            }
                            const isArrowKey = event.key === 'ArrowUp' || event.key === 'ArrowDown';
                            if (
                                isArrowKey &&
                                !hasModifier &&
                                stepHistory({
                                    textarea: extractEventTarget(event, HTMLTextAreaElement),
                                    isOlder: event.key === 'ArrowUp',
                                })
                            ) {
                                event.preventDefault();
                                return;
                            }
                            const isWorktreeShortcut = matchesShortcut({
                                event,
                                shortcuts: inputs.shortcuts.sendInWorktree,
                            });
                            if (
                                isWorktreeShortcut &&
                                inputs.canSendInWorktree &&
                                !inputs.questionAction
                            ) {
                                event.preventDefault();
                                submit({
                                    isInWorktree: true,
                                });
                            } else if (
                                isWorktreeShortcut ||
                                matchesShortcut({
                                    event,
                                    shortcuts: inputs.shortcuts.send,
                                })
                            ) {
                                event.preventDefault();
                                submit({
                                    isInWorktree: false,
                                });
                            }
                        })}
                    ></textarea>
                </div>
                <input
                    type="file"
                    multiple
                    hidden
                    ${listen('change', (event) => {
                        const input = extractEventTarget(event, HTMLInputElement);
                        const files = Array.from(input.files || []);
                        /** Clears the picker so picking the same file again still fires `change`. */
                        input.value = '';
                        if (files.length) {
                            dispatch(
                                new events.filesPicked({
                                    detail: files,
                                }),
                            );
                        }
                    })}
                />
                <div class="footer">
                    <div class="controls">
                        ${inputs.questionAction
                            ? nothing
                            : html`
                                  <${ViraButton.assign({
                                      icon: attachIcon,
                                      color: ViraColorVariant.Neutral,
                                      buttonEmphasis: ViraEmphasis.Subtle,
                                  })}
                                      class="action"
                                      ${tooltip('Attach files')}
                                      aria-label="Attach files"
                                      ${listen('click', () => {
                                          host.shadowRoot
                                              .querySelector<HTMLInputElement>('input[type="file"]')
                                              ?.click();
                                      })}
                                  ></${ViraButton}>
                              `}
                        <${VirAiChatPermissions.assign({
                            runtimeMode: inputs.runtimeMode,
                        })}
                            ${listen(VirAiChatPermissions.events.runtimeModeChange, (event) => {
                                dispatch(
                                    new events.runtimeModeChange({
                                        detail: event.detail,
                                    }),
                                );
                            })}
                        ></${VirAiChatPermissions}>
                        <${VirAiChatModelPicker.assign({
                            providerModels: inputs.providerModels,
                            provider: inputs.provider,
                            model: inputs.model,
                            effort: inputs.effort,
                            speedTier: inputs.speedTier,
                            isDisabled: inputs.isBusy,
                        })}
                            ${listen(VirAiChatModelPicker.events.modelChange, (event) => {
                                dispatch(
                                    new events.modelChange({
                                        detail: event.detail,
                                    }),
                                );
                            })}
                        ></${VirAiChatModelPicker}>
                        ${inputs.mcpThreadId
                            ? html`
                                  <${VirAiChatMcp.assign({
                                      threadId: inputs.mcpThreadId,
                                      isOpen: state.isMcpOpen,
                                  })}
                                      ${listen(VirAiChatMcp.events.openChange, (event) => {
                                          updateState({
                                              isMcpOpen: event.detail,
                                          });
                                      })}
                                  ></${VirAiChatMcp}>
                              `
                            : nothing}
                    </div>
                    <div class="actions">
                        ${inputs.canSendInWorktree && !inputs.questionAction && !showsStop
                            ? html`
                                  <${ViraButton.assign({
                                      icon: worktreeIcon,
                                      color: ViraColorVariant.Neutral,
                                      buttonEmphasis: ViraEmphasis.Subtle,
                                      isDisabled: !canSend,
                                  })}
                                      class="action"
                                      ${tooltip(
                                          withShortcutHint(
                                              'Open a new worktree and send',
                                              inputs.shortcuts.sendInWorktree,
                                          ),
                                      )}
                                      aria-label="Open a new worktree and send"
                                      ${listen('click', () => {
                                          submit({
                                              isInWorktree: true,
                                          });
                                      })}
                                  ></${ViraButton}>
                              `
                            : nothing}
                        ${inputs.canArchive
                            ? html`
                                  <${ViraButton.assign({
                                      icon: archiveIcon,
                                      color: ViraColorVariant.Neutral,
                                      buttonEmphasis: ViraEmphasis.Subtle,
                                      isDisabled: inputs.isBusy,
                                  })}
                                      class="action"
                                      ${tooltip(
                                          withShortcutHint(
                                              'Archive thread',
                                              inputs.shortcuts.archive,
                                          ),
                                      )}
                                      aria-label="Archive thread"
                                      ${listen('click', archive)}
                                  ></${ViraButton}>
                              `
                            : nothing}
                        ${showsStop
                            ? html`
                                  <${ViraButton.assign({
                                      icon: stopIcon,
                                      color: ViraColorVariant.Custom,
                                      isDisabled: inputs.isBusy,
                                  })}
                                      class="action stop"
                                      ${tooltip(
                                          withShortcutHint('Interrupt', inputs.shortcuts.interrupt),
                                      )}
                                      aria-label="Stop generation"
                                      ${listen('click', stop)}
                                  ></${ViraButton}>
                              `
                            : inputs.questionAction
                              ? html`
                                    <${ViraButton.assign({
                                        text: inputs.questionAction.label,
                                        color: ViraColorVariant.Brand,
                                        isDisabled: !canSend,
                                    })}
                                        class="action labeled"
                                        ${listen('click', () => {
                                            submit({
                                                isInWorktree: false,
                                            });
                                        })}
                                    ></${ViraButton}>
                                `
                              : html`
                                    <${ViraButton.assign({
                                        icon: sendIcon,
                                        color: ViraColorVariant.Brand,
                                        isDisabled: !canSend,
                                    })}
                                        class="action"
                                        ${tooltip(
                                            withShortcutHint(
                                                'Submit message',
                                                inputs.shortcuts.send,
                                            ),
                                        )}
                                        aria-label="Submit message"
                                        ${listen('click', () => {
                                            submit({
                                                isInWorktree: false,
                                            });
                                        })}
                                    ></${ViraButton}>
                                `}
                    </div>
                </div>
            </div>
        `;
    },
});
