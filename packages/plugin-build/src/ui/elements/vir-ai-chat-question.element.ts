import {defineAppElement} from '@agent-storm/core/frontend';
import {check} from '@augment-vir/assert';
import {classMap, css, defineElementEvent, html, listen, nothing} from 'element-vir';
import {
    createSizedIcon,
    LucideCheckIcon,
    LucideChevronDownIcon,
    LucideChevronLeftIcon,
    LucideXIcon,
    tooltip,
    ViraIcon,
    viraThemeByKeys,
} from 'vira';
import {type ApprovalRequest, type UserQuestion} from '../../build-api.js';
import {chatMarkdownStyles, renderChatMarkdown} from './markdown-styles.js';

const chevronIcon = createSizedIcon(LucideChevronDownIcon, 14);
const backIcon = createSizedIcon(LucideChevronLeftIcon, 14);
const dismissIcon = createSizedIcon(LucideXIcon, 14);
const checkIcon = createSizedIcon(LucideCheckIcon, 12);

/** What the user picked or typed for one question so far. */
export type QuestionAnswerDraft = Readonly<{
    selectedLabels: ReadonlyArray<string>;
    /** Typed into the composer. Replaces the picked options when it isn't blank. */
    customAnswer: string;
}>;

/** The answers to a `Question` request while the user works through its questions. */
export type QuestionDraft = Readonly<{
    requestId: string;
    questionIndex: number;
    /** One per question, in order. */
    answers: ReadonlyArray<QuestionAnswerDraft>;
}>;

/**
 * A fresh draft for `request`, keeping by position the answers of `unsentDraft`: a draft for an
 * earlier request that ended without the user sending it, such as one a restart declined before the
 * agent asked again. A picked option carries over only while the new question still offers it.
 */
export function createQuestionDraft({
    request,
    unsentDraft,
}: Readonly<{
    request: Readonly<ApprovalRequest>;
    unsentDraft?: QuestionDraft | undefined;
}>): QuestionDraft {
    return {
        requestId: request.id,
        questionIndex: 0,
        answers: request.questions.map((question, index) => {
            const unsentAnswer = unsentDraft?.answers[index];
            return {
                selectedLabels:
                    unsentAnswer?.selectedLabels.filter((label) => {
                        return question.options.some((option) => option.label === label);
                    }) || [],
                customAnswer: unsentAnswer?.customAnswer || '',
            };
        }),
    };
}

/** The text Claude receives for one question: the typed answer, else the picked labels. */
export function resolveQuestionAnswer(answer: QuestionAnswerDraft | undefined) {
    return answer?.customAnswer.trim() || answer?.selectedLabels.join(', ') || '';
}

/**
 * The question an agent waits on, docked above the composer. The composer types a custom answer,
 * and its send button moves to the next question or submits.
 */
export const VirAiChatQuestion = defineAppElement<{
    request: Readonly<ApprovalRequest>;
    draft: QuestionDraft;
    /** While the answers are being sent. */
    isBusy: boolean;
}>()({
    tagName: 'vir-ai-chat-question',
    events: {
        optionToggled: defineElementEvent<Pick<UserQuestion, 'isMultiSelect'> & {label: string}>(),
        previousRequested: defineElementEvent<void>(),
        dismissed: defineElementEvent<void>(),
    },
    state() {
        return {
            /** The question the user collapsed, so the next one opens again. */
            collapsedQuestion: undefined as string | undefined,
        };
    },
    styles: css`
        ${chatMarkdownStyles}

        :host {
            display: block;
            font-size: 14px;
            color: ${viraThemeByKeys.grey.foreground.body.foreground.value};
        }

        .card {
            display: flex;
            flex-direction: column;
            max-height: 50vh;
            box-sizing: border-box;
            border-radius: 16px;
            border: 1px solid ${viraThemeByKeys.grey.foreground.decoration.foreground.value};
            background-color: ${viraThemeByKeys.grey['behind-bg'].body.foreground.value};
            outline: none;
        }

        .header {
            display: flex;
            align-items: center;
            gap: 8px;
            min-width: 0;
            padding: 6px 8px 6px 16px;
        }

        .toggle {
            display: flex;
            flex-grow: 1;
            align-items: center;
            gap: 8px;
            min-width: 0;
            padding: 0;
            border: none;
            background: none;
            font: inherit;
            font-size: 13px;
            color: inherit;
            text-align: left;
            cursor: pointer;

            & .header-text {
                flex-shrink: 0;
                max-width: 50%;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
                color: ${viraThemeByKeys.grey.foreground['non-body'].foreground.value};
            }

            & .collapsed-question {
                flex-shrink: 1;
                min-width: 0;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }

            & .count {
                margin-left: auto;
                flex-shrink: 0;
                font-variant-numeric: tabular-nums;
                color: ${viraThemeByKeys.grey.foreground['non-body'].foreground.value};
            }

            & vira-icon {
                flex-shrink: 0;
                color: ${viraThemeByKeys.grey.foreground['non-body'].foreground.value};
                transition: transform 150ms;
            }

            &.collapsed vira-icon {
                transform: rotate(-90deg);
            }
        }

        .icon-button {
            display: inline-flex;
            flex-shrink: 0;
            align-items: center;
            justify-content: center;
            width: 24px;
            height: 24px;
            padding: 0;
            border: none;
            border-radius: 6px;
            background: none;
            color: ${viraThemeByKeys.grey.foreground['non-body'].foreground.value};
            cursor: pointer;

            &:hover:not(:disabled) {
                color: ${viraThemeByKeys.grey.foreground.body.foreground.value};
                background-color: ${viraThemeByKeys.brand['behind-fg']['small-body'].background
                    .value};
            }

            &:disabled {
                cursor: default;
                opacity: 0.5;
            }
        }

        .body {
            overflow-y: auto;
            padding: 0 16px 8px 24px;
            overflow-wrap: anywhere;
            scrollbar-width: thin;
        }

        .question {
            padding-top: 2px;
            user-select: text;
        }

        .options {
            display: flex;
            flex-direction: column;
            margin: 6px 0 0 -8px;
        }

        .option {
            display: flex;
            align-items: flex-start;
            gap: 10px;
            width: 100%;
            padding: 6px 0 6px 8px;
            border: none;
            border-radius: 6px;
            background: none;
            font: inherit;
            text-align: left;
            color: ${viraThemeByKeys.grey.foreground['non-body'].foreground.value};
            cursor: pointer;

            &:hover:not(:disabled) {
                background-color: ${viraThemeByKeys.brand['behind-fg']['small-body'].background
                    .value};
            }

            &.selected {
                color: ${viraThemeByKeys.grey.foreground.body.foreground.value};
            }

            &:focus-visible {
                outline: 2px solid ${viraThemeByKeys.blue.foreground.body.foreground.value};
                outline-offset: -2px;
            }

            &:disabled {
                cursor: default;
                opacity: 0.5;
            }
        }

        .slot {
            display: flex;
            flex-shrink: 0;
            align-items: center;
            justify-content: center;
            height: 20px;
        }

        .radio,
        .checkbox {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            box-sizing: border-box;
            width: 16px;
            height: 16px;
            border: 1px solid ${viraThemeByKeys.grey.foreground['non-body'].foreground.value};
            color: ${viraThemeByKeys.blue['on-self'].body.foreground.value};

            .selected & {
                border-color: ${viraThemeByKeys.blue['on-self'].body.background.value};
                background-color: ${viraThemeByKeys.blue['on-self'].body.background.value};
            }
        }

        .radio {
            border-radius: 50%;

            .selected &::after {
                content: '';
                width: 6px;
                height: 6px;
                border-radius: 50%;
                background-color: currentColor;
            }
        }

        .checkbox {
            border-radius: 4px;
        }

        .option-text {
            display: flex;
            flex-grow: 1;
            flex-direction: column;
            gap: 2px;
            min-width: 0;

            & .label {
                font-weight: 500;
            }

            & .description {
                font-size: 12px;
                color: ${viraThemeByKeys.grey.foreground['non-body'].foreground.value};
            }
        }

        kbd {
            width: 24px;
            font-family: inherit;
            font-size: 11px;
            text-align: center;
            border-radius: 4px;
            color: ${viraThemeByKeys.grey.foreground['non-body'].foreground.value};
            background-color: ${viraThemeByKeys.grey['behind-fg']['small-body'].background.value};
        }

        .preview {
            padding: 0 8px 6px 34px;
            font-size: 12px;
        }
    `,
    render({inputs, state, updateState, dispatch, events}) {
        const questionIndex = inputs.draft.questionIndex;
        const question = inputs.request.questions[questionIndex];
        if (!question) {
            return nothing;
        }
        const answer = inputs.draft.answers[questionIndex];
        const isCollapsed = state.collapsedQuestion === question.question;
        const isDisabled = inputs.isBusy;

        function toggleOption(label: string) {
            if (isDisabled || !question) {
                return;
            }
            dispatch(
                new events.optionToggled({
                    detail: {
                        label,
                        isMultiSelect: question.isMultiSelect,
                    },
                }),
            );
        }

        return html`
            <div
                class="card"
                role="group"
                aria-label="Question from the agent"
                tabindex="-1"
                ${listen('keydown', (event) => {
                    if (
                        isCollapsed ||
                        event.metaKey ||
                        event.ctrlKey ||
                        event.altKey ||
                        !/^[1-9]$/.test(event.key)
                    ) {
                        return;
                    }
                    const option = question.options[Number(event.key) - 1];
                    if (option) {
                        event.preventDefault();
                        toggleOption(option.label);
                    }
                })}
            >
                <div class="header">
                    ${questionIndex > 0
                        ? html`
                              <button
                                  type="button"
                                  class="icon-button"
                                  ${tooltip('Previous question')}
                                  aria-label="Previous question"
                                  ?disabled=${isDisabled}
                                  ${listen('click', () => {
                                      if (isDisabled) {
                                          return;
                                      }
                                      dispatch(
                                          new events.previousRequested({
                                              detail: undefined,
                                          }),
                                      );
                                  })}
                              >
                                  <${ViraIcon.assign({
                                      icon: backIcon,
                                  })}></${ViraIcon}>
                              </button>
                          `
                        : nothing}
                    <button
                        type="button"
                        class=${classMap({
                            toggle: true,
                            collapsed: isCollapsed,
                        })}
                        aria-expanded=${!isCollapsed}
                        ${tooltip(
                            isCollapsed
                                ? 'Show the question and its options'
                                : 'Hide the question and its options',
                        )}
                        ${listen('click', () => {
                            updateState({
                                collapsedQuestion: isCollapsed ? undefined : question.question,
                            });
                        })}
                    >
                        <span class="header-text">${question.header}</span>
                        ${isCollapsed
                            ? html`
                                  <span aria-hidden="true">·</span>
                                  <span class="collapsed-question">${question.question}</span>
                              `
                            : nothing}
                        ${inputs.request.questions.length > 1
                            ? html`
                                  <span class="count">
                                      ${questionIndex + 1}/${inputs.request.questions.length}
                                  </span>
                              `
                            : nothing}
                        <${ViraIcon.assign({
                            icon: chevronIcon,
                        })}></${ViraIcon}>
                    </button>
                    <button
                        type="button"
                        class="icon-button"
                        ${tooltip('Dismiss without answering')}
                        aria-label="Dismiss without answering"
                        ?disabled=${isDisabled}
                        ${listen('click', () => {
                            if (isDisabled) {
                                return;
                            }
                            dispatch(
                                new events.dismissed({
                                    detail: undefined,
                                }),
                            );
                        })}
                    >
                        <${ViraIcon.assign({
                            icon: dismissIcon,
                        })}></${ViraIcon}>
                    </button>
                </div>
                ${isCollapsed
                    ? nothing
                    : html`
                          <div class="body">
                              <div class="question">
                                  ${renderChatMarkdown({
                                      text: question.question,
                                      hasLineBreaks: true,
                                  })}
                              </div>
                              <div
                                  class="options"
                                  role=${question.isMultiSelect ? 'group' : 'radiogroup'}
                              >
                                  ${question.options.map((option, index) => {
                                      const isSelected =
                                          !answer?.customAnswer.trim() &&
                                          check.hasValue(
                                              answer?.selectedLabels || [],
                                              option.label,
                                          );
                                      return html`
                                          <button
                                              type="button"
                                              class=${classMap({
                                                  option: true,
                                                  selected: isSelected,
                                              })}
                                              role=${question.isMultiSelect ? 'checkbox' : 'radio'}
                                              aria-checked=${isSelected}
                                              ?disabled=${isDisabled}
                                              ${listen('click', () => {
                                                  toggleOption(option.label);
                                              })}
                                          >
                                              <span class="slot">
                                                  <span
                                                      class=${question.isMultiSelect
                                                          ? 'checkbox'
                                                          : 'radio'}
                                                  >
                                                      ${question.isMultiSelect && isSelected
                                                          ? html`
                                                                <${ViraIcon.assign({
                                                                    icon: checkIcon,
                                                                })}></${ViraIcon}>
                                                            `
                                                          : nothing}
                                                  </span>
                                              </span>
                                              <span class="option-text">
                                                  <span class="label">${option.label}</span>
                                                  ${option.description &&
                                                  option.description !== option.label
                                                      ? html`
                                                            <span class="description">
                                                                ${option.description}
                                                            </span>
                                                        `
                                                      : nothing}
                                              </span>
                                              ${index < 9
                                                  ? html`
                                                        <span class="slot">
                                                            <kbd>${index + 1}</kbd>
                                                        </span>
                                                    `
                                                  : nothing}
                                          </button>
                                          ${option.preview
                                              ? html`
                                                    <div class="preview">
                                                        ${renderChatMarkdown({
                                                            text: option.preview,
                                                            hasLineBreaks: true,
                                                        })}
                                                    </div>
                                                `
                                              : nothing}
                                      `;
                                  })}
                              </div>
                          </div>
                      `}
            </div>
        `;
    },
});
