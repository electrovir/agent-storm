import {defineAppElement, type AppContext} from '@agent-storm/core/frontend';
import {
    createCuid2,
    extractErrorMessage,
    getEnumValues,
    mapObjectValues,
    wait,
    wrapInTry,
} from '@augment-vir/common';
import {classMap, css, defineElementEvent, html, listen, nothing} from 'element-vir';
import {
    createSizedIcon,
    LucideCircleAlertIcon,
    LucideGitBranchIcon,
    tooltip,
    ViraButton,
    ViraColorVariant,
    ViraIcon,
    ViraSize,
    ViraTag,
    viraThemeByKeys,
} from 'vira';
import {
    AiProvider,
    ApprovalDecision,
    ApprovalKind,
    RuntimeMode,
    ThreadItemKind,
    ThreadStatus,
    type ApprovalRequest,
    type ComposerCommand,
    type Thread,
    type ThreadItem,
} from '../../build-v2-api.js';
import {buildV2Client} from '../../util/build-v2-client.js';
import {buildV2Memory, toComposerDraftKey} from '../../util/build-v2-memory.js';
import {composerShortcutActions} from '../../util/composer-shortcuts.js';
import {collectDroppedFiles, fileToBase64, toImageThumbnailUrl} from '../../util/file-drop.js';
import {
    attachmentPreviewLength,
    attachmentThumbnailSize,
    pastedTextFilename,
    splitMessageAttachments,
    toAttachmentTag,
} from '../../util/message-attachments.js';
import {
    fillMissingModelDefaults,
    findModelDefaultsFolder,
    resolveModelDefault,
} from '../../util/model-defaults.js';
import {applyItemDelta, findPathName, upsertItems} from '../../util/thread-timeline.js';
import {threadStatusDisplays} from './thread-display.js';
import {VirAiChatApproval} from './vir-ai-chat-approval.element.js';
import {VirAiChatComposer, type ComposerAttachment} from './vir-ai-chat-composer.element.js';
import {type ModelSelection, type ProviderModelList} from './vir-ai-chat-model-picker.element.js';
import {
    createQuestionDraft,
    resolveQuestionAnswer,
    VirAiChatQuestion,
    type QuestionAnswerDraft,
    type QuestionDraft,
} from './vir-ai-chat-question.element.js';
import {VirAiChatTimeline} from './vir-ai-chat-timeline.element.js';

const branchIcon = createSizedIcon(LucideGitBranchIcon, 12);
const worktreeIcon = createSizedIcon(LucideGitBranchIcon, 14);
const errorIcon = createSizedIcon(LucideCircleAlertIcon, 16);

/**
 * One chat thread: its header, timeline, pending approval, and composer. Without a `threadId` it is
 * the new-thread composer, which creates the thread on the first send and emits `threadCreated`.
 * The thread is read once, so give each thread its own element (`keyed`).
 */
export const VirAiChat = defineAppElement<{
    context: AppContext;
    /** Undefined for a thread that doesn't exist yet. */
    threadId: string | undefined;
    /** The checkout a new thread starts in. */
    repoPath: string;
    /** Focuses the composer each time this turns on. */
    isShown: boolean;
}>()({
    tagName: 'vir-ai-chat',
    events: {
        threadCreated: defineElementEvent<Thread>(),
        threadArchived: defineElementEvent<void>(),
    },
    state() {
        return {
            thread: undefined as Readonly<Thread> | undefined,
            items: [] as ReadonlyArray<Readonly<ThreadItem>>,
            requests: [] as ReadonlyArray<Readonly<ApprovalRequest>>,
            isLoading: false,
            error: undefined as string | undefined,
            isErrorExpanded: false,
            composerText: '',
            /** The model a new thread starts with. Unset to use the folder's or global default. */
            modelSelection: undefined as ModelSelection | undefined,
            /** The runtime mode a new thread starts with. */
            runtimeMode: RuntimeMode.FullAccess,
            providerModels: {} as Readonly<Partial<Record<AiProvider, ProviderModelList>>>,
            /** The composer's `/` and `$` menu, for the provider and folder `listKey` names. */
            composerCommands: undefined as
                | Readonly<{
                      listKey: string;
                      commands: ReadonlyArray<Readonly<ComposerCommand>>;
                  }>
                | undefined,
            isSending: false,
            /**
             * Files attached to the unsent message. Their upload paths are appended to the message
             * when it sends.
             */
            attachments: [] as ReadonlyArray<Readonly<ComposerAttachment>>,
            isDraggingFiles: false,
            /** The request whose answer is being sent. */
            busyRequestId: undefined as string | undefined,
            /** Answers to the pending question so far. Ignored once a different request is first. */
            questionDraft: undefined as QuestionDraft | undefined,
            isMoving: false,
            removers: [] as ReadonlyArray<() => Promise<void>>,
            removeReconnectListener: (() => {}) as () => void,
            removeSeenWatchers: (() => {}) as () => void,
        };
    },
    init({inputs, updateState, host}) {
        updateState({
            composerText: buildV2Memory.composerDrafts.readFolder(toComposerDraftKey(inputs)) || '',
            attachments: (
                buildV2Memory.composerAttachments.readFolder(toComposerDraftKey(inputs)) || []
            ).map((saved) => {
                return {
                    ...saved,
                    imageUrl: saved.imageUrl || undefined,
                    textPreview: saved.textPreview || undefined,
                };
            }),
        });
        getEnumValues(AiProvider).forEach((provider) => {
            buildV2Client
                .call('listModels', {
                    provider,
                })
                .then(({models}) => {
                    updateState({
                        providerModels: {
                            ...host.instanceState.providerModels,
                            [provider]: {
                                models,
                            },
                        },
                    });
                })
                .catch((error: unknown) => {
                    updateState({
                        providerModels: {
                            ...host.instanceState.providerModels,
                            [provider]: {
                                errorMessage: extractErrorMessage(error),
                            },
                        },
                    });
                });
        });
        const threadId = inputs.threadId;
        if (!threadId) {
            return;
        }
        updateState({
            isLoading: true,
            removers: [
                buildV2Client.listen('threadChanged', (thread) => {
                    if (thread.id === threadId) {
                        updateState({
                            thread,
                        });
                        markReadIfSeen(thread.id);
                    }
                }),
                buildV2Client.listen('itemsChanged', ({threadId: changedId, items}) => {
                    if (changedId === threadId) {
                        updateState({
                            items: upsertItems({
                                items: host.instanceState.items,
                                changedItems: items,
                            }),
                        });
                    }
                }),
                buildV2Client.listen('itemDelta', (delta) => {
                    if (delta.threadId === threadId) {
                        updateState({
                            items: applyItemDelta(host.instanceState.items, delta),
                        });
                    }
                }),
                buildV2Client.listen('requestsChanged', ({threadId: changedId, requests}) => {
                    if (changedId === threadId) {
                        updateState({
                            requests,
                        });
                    }
                }),
            ],
        });
        function readThread(threadId: string) {
            buildV2Client
                .call('readThread', {
                    threadId,
                })
                .then((loaded) => {
                    updateState({
                        thread: loaded.thread,
                        /** Items an event delivered while the read was in flight are newer. */
                        items: upsertItems({
                            items: loaded.items,
                            changedItems: host.instanceState.items,
                        }),
                        requests: loaded.requests,
                        isLoading: false,
                    });
                    markReadIfSeen(threadId);
                })
                .catch((error: unknown) => {
                    updateState({
                        error: extractErrorMessage(error),
                        isLoading: false,
                    });
                });
        }
        /**
         * Chat tabs stay mounted while another tab covers them, which leaves them out of every slot
         * and so not visible.
         */
        function markReadIfSeen(threadId: string) {
            if (
                host.instanceState.thread?.hasUnreadReply &&
                document.visibilityState === 'visible' &&
                host.checkVisibility()
            ) {
                buildV2Client
                    .call('markThreadRead', {
                        threadId,
                    })
                    .catch((error: unknown) => {
                        updateState({
                            error: extractErrorMessage(error),
                        });
                    });
            }
        }
        readThread(threadId);
        const visibilityObserver = new IntersectionObserver(() => {
            markReadIfSeen(threadId);
        });
        visibilityObserver.observe(host);
        const handleVisibilityChange = markReadIfSeen.bind(undefined, threadId);
        document.addEventListener('visibilitychange', handleVisibilityChange);
        updateState({
            removeReconnectListener: buildV2Client.listenToReconnect(() => {
                readThread(threadId);
            }),
            removeSeenWatchers() {
                visibilityObserver.disconnect();
                document.removeEventListener('visibilitychange', handleVisibilityChange);
            },
        });
    },
    cleanup({state}) {
        state.removeReconnectListener();
        state.removeSeenWatchers();
        void Promise.all(state.removers.map(async (remove) => await remove()));
    },
    styles: css`
        :host {
            display: flex;
            flex-direction: column;
            height: 100%;
            min-height: 0;
            box-sizing: border-box;
            background-color: ${viraThemeByKeys.grey['behind-bg'].body.foreground.value};
            color: ${viraThemeByKeys.grey.foreground.body.foreground.value};
            font-size: 14px;
        }

        .column {
            position: relative;
            display: flex;
            flex-direction: column;
            flex-grow: 1;
            min-height: 0;
            min-width: 0;
            overflow-x: hidden;
        }

        header {
            display: flex;
            align-items: center;
            flex-shrink: 0;
            gap: 12px;
            height: 52px;
            box-sizing: border-box;
            padding: 0 12px;

            & nav {
                flex-grow: 1;
                min-width: 0;
            }

            & ol {
                display: flex;
                align-items: center;
                gap: 12px;
                min-width: 0;
                margin: 0;
                padding: 0;
                list-style: none;
            }

            & li {
                display: flex;
                align-items: center;
                min-width: 0;
                font-weight: 500;

                &.project {
                    flex-shrink: 1;
                    color: ${viraThemeByKeys.grey.foreground['non-body'].foreground.value};
                }

                &.separator {
                    flex-shrink: 0;
                    color: ${viraThemeByKeys.grey.foreground.placeholder.foreground.value};
                }

                &.title {
                    flex-grow: 1;
                    min-width: 40px;
                }
            }

            & h2 {
                flex-grow: 1;
                min-width: 0;
                margin: 0;
                font-size: inherit;
                font-weight: inherit;
            }

            & .crumb {
                display: block;
                min-width: 0;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;

                &.project-name {
                    max-width: 160px;
                }
            }

            & .actions {
                display: flex;
                flex-shrink: 0;
                align-items: center;
                gap: 6px;
            }

            & .branch {
                display: inline-flex;
                align-items: center;
                gap: 4px;
                height: 20px;
                box-sizing: border-box;
                padding: 0 6px;
                border-radius: 4px;
                border: 1px solid ${viraThemeByKeys.grey.foreground.decoration.foreground.value};
                font-size: 11px;
                font-weight: 500;
                white-space: nowrap;
            }
        }

        .content {
            position: relative;
            display: flex;
            flex-direction: column;
            flex-grow: 1;
            min-height: 0;
            min-width: 0;
        }

        .drop-overlay {
            position: absolute;
            inset: 8px;
            z-index: 40;
            display: flex;
            align-items: center;
            justify-content: center;
            border: 2px dashed ${viraThemeByKeys.blue['on-self'].body.background.value};
            border-radius: 16px;
            background-color: ${viraThemeByKeys.grey['behind-bg'].body.foreground.value};
            color: ${viraThemeByKeys.blue.foreground['highest-contrast'].foreground.value};
            font-size: 16px;
            font-weight: 500;
            opacity: 0.92;
        }

        .lane {
            padding-left: 12px;
            padding-right: 12px;

            @media (min-width: 640px) {
                padding-left: 48px;
                padding-right: 48px;
            }
        }

        .lane-content {
            box-sizing: border-box;
            width: 100%;
            max-width: 46rem;
            margin-left: auto;
            margin-right: auto;
        }

        .banner-lane {
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            z-index: 30;
            display: flex;
            justify-content: center;
            pointer-events: none;
        }

        .error-banner {
            display: flex;
            align-items: flex-start;
            gap: 8px;
            box-sizing: border-box;
            width: fit-content;
            max-width: min(48rem, calc(100% - 32px));
            margin-top: 12px;
            padding: 12px 14px;
            border-radius: 12px;
            border: 1px solid ${viraThemeByKeys.red.foreground.decoration.foreground.value};
            background-color: ${viraThemeByKeys.red['behind-bg']['lowest-contrast'].background
                .value};
            color: ${viraThemeByKeys.red.foreground['highest-contrast'].foreground.value};
            pointer-events: auto;

            & vira-icon {
                flex-shrink: 0;
                margin-top: 2px;
                color: ${viraThemeByKeys.red.foreground.body.foreground.value};
            }

            & .error-body {
                display: flex;
                flex-direction: column;
                align-items: flex-start;
                gap: 4px;
                min-width: 0;
            }

            & .error-text {
                overflow-wrap: anywhere;

                & span {
                    white-space: pre-wrap;
                }

                &.clamped {
                    display: -webkit-box;
                    overflow: hidden;
                    -webkit-box-orient: vertical;
                    -webkit-line-clamp: 3;
                }
            }

            & button {
                padding: 0;
                border: none;
                background: none;
                font: inherit;
                font-weight: 500;
                color: ${viraThemeByKeys.grey.foreground['non-body'].foreground.value};
                cursor: pointer;
                text-underline-offset: 2px;

                &:hover {
                    text-decoration: underline;
                    color: ${viraThemeByKeys.grey.foreground.body.foreground.value};
                }
            }
        }

        .scroller {
            display: flex;
            flex-direction: column-reverse;
            flex-grow: 1;
            min-height: 0;
            overflow-y: auto;

            & .lane-content {
                padding-top: 16px;
                padding-bottom: 16px;
            }
        }

        .loading {
            padding: 32px 0;
            text-align: center;
            color: ${viraThemeByKeys.grey.foreground['non-body'].foreground.value};
        }

        .composer-lane {
            flex-shrink: 0;
            padding-top: 8px;
            padding-bottom: 12px;

            & .lane-content {
                display: flex;
                flex-direction: column;
                gap: 8px;
            }
        }

        .draft {
            display: flex;
            align-items: center;
            flex-grow: 1;
            min-height: 0;

            & .hero-anchor {
                position: relative;
                width: 100%;
            }

            & .hero {
                position: absolute;
                left: 0;
                right: 0;
                bottom: 100%;
                padding-bottom: 16px;
            }

            & h1 {
                margin: 0;
                font-size: 24px;
                font-weight: 500;
                letter-spacing: -0.025em;
                text-align: center;

                @media (min-width: 640px) {
                    font-size: 30px;
                }
            }
        }
    `,
    render({inputs, state, updateState, dispatch, events, host}) {
        const isDraft = !inputs.threadId;
        const isRunning = state.thread?.status === ThreadStatus.Running;
        const status = state.thread ? threadStatusDisplays[state.thread.status] : undefined;
        const cwd = state.thread?.cwd || inputs.repoPath;
        const branch =
            state.thread?.worktreeBranch ||
            inputs.context.folderData.value.folderInfo.get(cwd)?.branch;
        const canMoveToWorktree = !!state.thread && !state.thread.worktreeBranch;
        const request = state.requests[0];
        const questionRequest = request?.kind === ApprovalKind.Question ? request : undefined;
        const questionDraft = questionRequest
            ? state.questionDraft?.requestId === questionRequest.id
                ? state.questionDraft
                : createQuestionDraft(questionRequest)
            : undefined;
        const activeAnswer = questionDraft?.answers[questionDraft.questionIndex];
        const modelDefaultsFolder = findModelDefaultsFolder({
            context: inputs.context,
            path: state.thread?.repoPath || inputs.repoPath,
        });
        const modelDefault = resolveModelDefault({
            context: inputs.context,
            folder: modelDefaultsFolder,
        });
        const draftSelection: ModelSelection = state.modelSelection || {
            provider: modelDefault?.provider || AiProvider.Claude,
            model: modelDefault?.model || '',
            effort: modelDefault?.effort || undefined,
            speedTier: undefined,
        };

        async function runAction(action: () => Promise<void>) {
            try {
                updateState({
                    error: undefined,
                });
                await action();
            } catch (error) {
                updateState({
                    error: extractErrorMessage(error),
                });
            }
        }

        /** Saved on every change so the message survives a reload or a backend restart. */
        function setComposerText(text: string) {
            updateState({
                composerText: text,
            });
            buildV2Memory.composerDrafts.writeFolder({
                folder: toComposerDraftKey(inputs),
                value: text || undefined,
            });
        }

        /** Saved like the message text, minus any attachment still uploading. */
        function setAttachments(attachments: ReadonlyArray<Readonly<ComposerAttachment>>) {
            updateState({
                attachments,
            });
            const uploaded = attachments.flatMap((attachment) => {
                return attachment.path
                    ? [
                          {
                              ...attachment,
                              path: attachment.path,
                          },
                      ]
                    : [];
            });
            buildV2Memory.composerAttachments.writeFolder({
                folder: toComposerDraftKey(inputs),
                value: uploaded.length ? uploaded : undefined,
            });
        }

        async function send({
            text,
            isInWorktree,
        }: Readonly<{
            text: string;
            isInWorktree: boolean;
        }>) {
            updateState({
                isSending: true,
            });
            const sentAttachments = host.instanceState.attachments;
            const message = [
                text,
                ...sentAttachments.map((attachment) => attachment.path),
            ]
                .filter((part) => !!part)
                .join('\n');
            function clearComposer() {
                setComposerText('');
                setAttachments(
                    host.instanceState.attachments.filter(
                        (attachment) => !sentAttachments.includes(attachment),
                    ),
                );
            }
            await runAction(async () => {
                if (inputs.threadId) {
                    await buildV2Client.call('sendMessage', {
                        threadId: inputs.threadId,
                        text: message,
                    });
                    clearComposer();
                } else {
                    const {thread} = await buildV2Client.call('createThread', {
                        repoPath: inputs.repoPath,
                        provider: draftSelection.provider,
                        model: draftSelection.model,
                        effort: draftSelection.effort,
                        speedTier: draftSelection.speedTier,
                        runtimeMode: state.runtimeMode,
                        text: message,
                        isInWorktree,
                    });
                    clearComposer();
                    dispatch(
                        new events.threadCreated({
                            detail: thread,
                        }),
                    );
                }
            });
            updateState({
                isSending: false,
            });
        }

        /** Shows the file's card right away and fills in its path once the upload lands. */
        async function attachFile({
            file,
            textPreview,
        }: Readonly<{
            file: File;
            /** Set for pasted text. */
            textPreview: string | undefined;
        }>) {
            const id = createCuid2();
            try {
                const dataBase64 = await fileToBase64(file);
                const imageUrl = file.type.startsWith('image/')
                    ? await toImageThumbnailUrl({
                          file,
                          size: attachmentThumbnailSize,
                      }).catch(() => {
                          return `data:${file.type};base64,${dataBase64}`;
                      })
                    : undefined;
                /** No await between reading and writing the list, so concurrent drops all land. */
                updateState({
                    attachments: [
                        ...host.instanceState.attachments,
                        {
                            id,
                            name: file.name,
                            tag: toAttachmentTag(file.name),
                            path: undefined,
                            imageUrl,
                            textPreview,
                        },
                    ],
                });
                const {path} = await buildV2Client.call('uploadFile', {
                    filename: file.name,
                    dataBase64,
                });
                setAttachments(
                    host.instanceState.attachments.map((attachment) => {
                        return attachment.id === id
                            ? {
                                  ...attachment,
                                  path,
                              }
                            : attachment;
                    }),
                );
            } catch (error) {
                setAttachments(
                    host.instanceState.attachments.filter((attachment) => attachment.id !== id),
                );
                updateState({
                    error: extractErrorMessage(error),
                });
            }
        }

        async function attachFiles(files: ReadonlyArray<File>) {
            await Promise.all(
                files.map((file) => {
                    return attachFile({
                        file,
                        textPreview: undefined,
                    });
                }),
            );
        }

        async function moveToWorktree(requestId: string | undefined) {
            if (!state.thread) {
                return;
            }
            const threadId = state.thread.id;
            updateState({
                isMoving: true,
            });
            await runAction(async () => {
                const {thread} = await buildV2Client.call('moveToWorktree', {
                    threadId,
                    requestId: requestId ?? null,
                });
                updateState({
                    thread,
                });
            });
            updateState({
                isMoving: false,
            });
        }

        async function decide(
            requestId: string,
            decision: ApprovalDecision,
            answers: ReadonlyArray<string> = [],
        ) {
            updateState({
                busyRequestId: requestId,
            });
            await runAction(async () => {
                await buildV2Client.call('resolveRequest', {
                    requestId,
                    decision,
                    answers: [
                        ...answers,
                    ],
                });
                updateState({
                    requests: host.instanceState.requests.filter(
                        (existing) => existing.id !== requestId,
                    ),
                    questionDraft: undefined,
                });
            });
            updateState({
                busyRequestId: undefined,
            });
        }

        function withActiveAnswer(draft: QuestionDraft, answer: QuestionAnswerDraft) {
            return {
                ...draft,
                answers: draft.answers.map((existing, index) => {
                    return index === draft.questionIndex ? answer : existing;
                }),
            };
        }

        /** Moves to the next question, or submits every answer from the last one. */
        async function advanceQuestion(draft: QuestionDraft) {
            if (!questionRequest || !resolveQuestionAnswer(draft.answers[draft.questionIndex])) {
                return;
            }
            if (draft.questionIndex < questionRequest.questions.length - 1) {
                updateState({
                    questionDraft: {
                        ...draft,
                        questionIndex: draft.questionIndex + 1,
                    },
                });
            } else {
                await decide(
                    questionRequest.id,
                    ApprovalDecision.Approve,
                    draft.answers.map(resolveQuestionAnswer),
                );
            }
        }

        async function toggleQuestionOption({
            label,
            isMultiSelect,
        }: Readonly<{
            label: string;
            isMultiSelect: boolean;
        }>) {
            if (!questionDraft || !activeAnswer) {
                return;
            }
            const picked = withActiveAnswer(questionDraft, {
                selectedLabels: isMultiSelect
                    ? activeAnswer.selectedLabels.includes(label)
                        ? activeAnswer.selectedLabels.filter((existing) => existing !== label)
                        : [
                              ...activeAnswer.selectedLabels,
                              label,
                          ]
                    : [
                          label,
                      ],
                customAnswer: '',
            });
            updateState({
                questionDraft: picked,
            });
            if (isMultiSelect) {
                return;
            }
            /** Lets the pick show before the next question replaces it. */
            await wait({
                milliseconds: 200,
            });
            const current = host.instanceState.questionDraft;
            if (
                current?.requestId === picked.requestId &&
                current.questionIndex === picked.questionIndex &&
                resolveQuestionAnswer(current.answers[current.questionIndex]) === label
            ) {
                await advanceQuestion(current);
            }
        }

        const commandProvider = state.thread?.provider || draftSelection.provider;
        const commandListKey = `${commandProvider}:${cwd}`;

        const composer = html`
            <${VirAiChatComposer.assign({
                text: activeAnswer ? activeAnswer.customAnswer : state.composerText,
                history: state.items
                    .filter((item) => item.kind === ThreadItemKind.UserMessage)
                    .flatMap((item) => {
                        const {text} = splitMessageAttachments(item.text);
                        return text
                            ? [
                                  text,
                              ]
                            : [];
                    }),
                placeholder: activeAnswer
                    ? 'Type your own answer, or leave this blank to use the selected option'
                    : isDraft
                      ? 'Ask anything…'
                      : 'Ask for follow-up changes…',
                isRunning,
                isBusy: state.isSending || state.attachments.some((attachment) => !attachment.path),
                canArchive:
                    !!inputs.threadId &&
                    state.items.some((item) => item.kind === ThreadItemKind.AssistantMessage),
                canSendInWorktree: isDraft,
                attachments: activeAnswer ? [] : state.attachments,
                providerModels: state.providerModels,
                provider: state.thread?.provider || draftSelection.provider,
                model: state.thread ? state.thread.model : draftSelection.model,
                effort: state.thread ? state.thread.effort || undefined : draftSelection.effort,
                speedTier: state.thread
                    ? state.thread.speedTier || undefined
                    : draftSelection.speedTier,
                runtimeMode: state.thread?.runtimeMode || state.runtimeMode,
                /** A list for another provider or folder stays out, and the menu shows it loading. */
                commands:
                    state.composerCommands?.listKey === commandListKey
                        ? state.composerCommands.commands
                        : undefined,
                isShown: inputs.isShown,
                shortcuts: mapObjectValues(composerShortcutActions, (_name, action) => {
                    return inputs.context.readShortcuts(action);
                }),
                questionAction:
                    questionRequest && questionDraft
                        ? {
                              label:
                                  state.busyRequestId === questionRequest.id
                                      ? 'Submitting…'
                                      : questionDraft.questionIndex <
                                          questionRequest.questions.length - 1
                                        ? 'Next question'
                                        : questionRequest.questions.length > 1
                                          ? 'Submit answers'
                                          : 'Submit answer',
                              isEnabled: !!resolveQuestionAnswer(activeAnswer),
                          }
                        : undefined,
            })}
                ${listen(VirAiChatComposer.events.textChange, (event) => {
                    if (questionDraft && activeAnswer) {
                        updateState({
                            questionDraft: withActiveAnswer(questionDraft, {
                                ...activeAnswer,
                                customAnswer: event.detail,
                            }),
                        });
                    } else {
                        setComposerText(event.detail);
                    }
                })}
                ${listen(VirAiChatComposer.events.commandsRequested, async () => {
                    const commands = await wrapInTry(
                        async () => {
                            return (
                                await buildV2Client.call('listCommands', {
                                    provider: commandProvider,
                                    cwd,
                                })
                            ).commands;
                        },
                        {
                            fallbackValue: [],
                        },
                    );
                    updateState({
                        composerCommands: {
                            listKey: commandListKey,
                            commands,
                        },
                    });
                })}
                ${listen(VirAiChatComposer.events.modelChange, async (event) => {
                    const threadId = inputs.threadId;
                    await runAction(async () => {
                        if (threadId) {
                            const {thread} = await buildV2Client.call('setThreadModel', {
                                threadId,
                                ...event.detail,
                            });
                            updateState({
                                thread,
                            });
                        } else {
                            updateState({
                                modelSelection: event.detail,
                            });
                        }
                        await fillMissingModelDefaults({
                            context: inputs.context,
                            folder: modelDefaultsFolder,
                            modelDefault: {
                                provider: event.detail.provider,
                                model: event.detail.model,
                                effort: event.detail.effort,
                            },
                        });
                    });
                })}
                ${listen(VirAiChatComposer.events.runtimeModeChange, async (event) => {
                    const threadId = inputs.threadId;
                    if (!threadId) {
                        updateState({
                            runtimeMode: event.detail,
                        });
                        return;
                    }
                    await runAction(async () => {
                        const {thread} = await buildV2Client.call('setThreadRuntimeMode', {
                            threadId,
                            runtimeMode: event.detail,
                        });
                        updateState({
                            thread,
                        });
                    });
                })}
                ${listen(VirAiChatComposer.events.submitted, async (event) => {
                    if (questionDraft) {
                        await advanceQuestion(questionDraft);
                    } else {
                        await send({
                            text: event.detail,
                            isInWorktree: false,
                        });
                    }
                })}
                ${listen(VirAiChatComposer.events.worktreeSubmitted, async (event) => {
                    await send({
                        text: event.detail,
                        isInWorktree: true,
                    });
                })}
                ${listen(VirAiChatComposer.events.filesPicked, async (event) => {
                    await attachFiles(event.detail);
                })}
                ${listen(VirAiChatComposer.events.textPasted, async (event) => {
                    await attachFile({
                        file: new File(
                            [
                                event.detail,
                            ],
                            pastedTextFilename,
                            {
                                type: 'text/plain',
                            },
                        ),
                        textPreview: event.detail.slice(0, attachmentPreviewLength),
                    });
                })}
                ${listen(VirAiChatComposer.events.attachmentRemoved, (event) => {
                    setAttachments(
                        state.attachments.filter((attachment) => attachment.id !== event.detail),
                    );
                })}
                ${listen(VirAiChatComposer.events.stopRequested, async () => {
                    const threadId = inputs.threadId;
                    if (!threadId) {
                        return;
                    }
                    updateState({
                        isSending: true,
                    });
                    await runAction(async () => {
                        await buildV2Client.call('interrupt', {
                            threadId,
                        });
                    });
                    updateState({
                        isSending: false,
                    });
                })}
                ${listen(VirAiChatComposer.events.archiveRequested, async () => {
                    const threadId = inputs.threadId;
                    if (!threadId) {
                        return;
                    }
                    await runAction(async () => {
                        await buildV2Client.call('archiveThread', {
                            threadId,
                        });
                        dispatch(
                            new events.threadArchived({
                                detail: undefined,
                            }),
                        );
                    });
                })}
            ></${VirAiChatComposer}>
        `;

        const projectPath = state.thread?.repoPath || inputs.repoPath;
        const projectName = projectPath ? findPathName(projectPath) : '';

        const header = html`
            <header data-chat-header>
                <nav aria-label="Thread breadcrumb">
                    <ol>
                        <li class="project">
                            <span class="crumb project-name" ${tooltip(cwd)}>${projectName}</span>
                        </li>
                        <li class="separator" aria-hidden="true">/</li>
                        <li class="title" aria-current="page">
                            <h2
                                aria-label=${state.thread?.title || 'New thread'}
                                ${state.thread?.title ? tooltip(state.thread.title) : nothing}
                            >
                                <span class="crumb">${state.thread?.title || 'New thread'}</span>
                            </h2>
                        </li>
                    </ol>
                </nav>
                <div class="actions">
                    ${status?.hasTag
                        ? html`
                              <${ViraTag.assign({
                                  text: status.label,
                                  size: ViraSize.Small,
                                  color: status.tagColor,
                              })}></${ViraTag}>
                          `
                        : nothing}
                    ${branch
                        ? html`
                              <span class="branch" ${tooltip(cwd)}>
                                  <${ViraIcon.assign({
                                      icon: branchIcon,
                                  })}></${ViraIcon}>
                                  ${branch}
                              </span>
                          `
                        : nothing}
                    ${canMoveToWorktree
                        ? html`
                              <${ViraButton.assign({
                                  text: 'Move to worktree',
                                  icon: worktreeIcon,
                                  buttonSize: ViraSize.Small,
                                  color: ViraColorVariant.Neutral,
                                  isDisabled: isRunning || state.isMoving,
                              })}
                                  ${tooltip('Continue this thread in a new worktree of its own')}
                                  ${listen('click', async () => {
                                      if (isRunning || state.isMoving) {
                                          return;
                                      }
                                      await moveToWorktree(undefined);
                                  })}
                              ></${ViraButton}>
                          `
                        : nothing}
                </div>
            </header>
        `;

        const canExpandError =
            !!state.error && (state.error.length > 180 || state.error.includes('\n'));
        const errorBanner = state.error
            ? html`
                  <div class="banner-lane">
                      <div class="error-banner" role="alert">
                          <${ViraIcon.assign({
                              icon: errorIcon,
                          })}></${ViraIcon}>
                          <div class="error-body">
                              <div
                                  id="error-text"
                                  class=${classMap({
                                      'error-text': true,
                                      clamped: !state.isErrorExpanded && canExpandError,
                                  })}
                              >
                                  <span>${state.error}</span>
                              </div>
                              ${canExpandError
                                  ? html`
                                        <button
                                            type="button"
                                            aria-expanded=${state.isErrorExpanded}
                                            aria-controls="error-text"
                                            ${listen('click', () => {
                                                updateState({
                                                    isErrorExpanded: !state.isErrorExpanded,
                                                });
                                            })}
                                        >
                                            ${state.isErrorExpanded
                                                ? 'Show less'
                                                : 'Show full error'}
                                        </button>
                                    `
                                  : nothing}
                          </div>
                      </div>
                  </div>
              `
            : nothing;

        const approval =
            request && !questionRequest
                ? html`
                      <${VirAiChatApproval.assign({
                          request,
                          requestCount: state.requests.length,
                          isBusy: state.busyRequestId === request.id || state.isMoving,
                          canMoveToWorktree,
                      })}
                          ${listen(VirAiChatApproval.events.decided, async (event) => {
                              await decide(request.id, event.detail);
                          })}
                          ${listen(VirAiChatApproval.events.moveToWorktreeRequested, async () => {
                              await moveToWorktree(request.id);
                          })}
                      ></${VirAiChatApproval}>
                  `
                : nothing;

        const scroller = html`
            <div class="scroller">
                <div class="lane">
                    <div class="lane-content">
                        ${state.isLoading && !state.items.length
                            ? html`
                                  <div class="loading">Loading thread…</div>
                              `
                            : html`
                                  <${VirAiChatTimeline.assign({
                                      items: state.items,
                                      isRunning,
                                  })}></${VirAiChatTimeline}>
                              `}
                        ${approval}
                    </div>
                </div>
            </div>
            <div class="lane composer-lane">
                <div class="lane-content">
                    ${questionRequest && questionDraft
                        ? html`
                              <${VirAiChatQuestion.assign({
                                  request: questionRequest,
                                  draft: questionDraft,
                                  isBusy: state.busyRequestId === questionRequest.id,
                              })}
                                  ${listen(
                                      VirAiChatQuestion.events.optionToggled,
                                      async (event) => {
                                          await toggleQuestionOption(event.detail);
                                      },
                                  )}
                                  ${listen(VirAiChatQuestion.events.previousRequested, () => {
                                      updateState({
                                          questionDraft: {
                                              ...questionDraft,
                                              questionIndex: Math.max(
                                                  0,
                                                  questionDraft.questionIndex - 1,
                                              ),
                                          },
                                      });
                                  })}
                                  ${listen(VirAiChatQuestion.events.dismissed, async () => {
                                      await decide(questionRequest.id, ApprovalDecision.Decline);
                                  })}
                              ></${VirAiChatQuestion}>
                          `
                        : nothing}
                    ${composer}
                </div>
            </div>
        `;

        const draftHero = html`
            <div class="lane draft">
                <div class="lane-content hero-anchor">
                    <div class="hero">
                        <h1>${findPathName(inputs.repoPath)}</h1>
                    </div>
                    ${composer}
                </div>
            </div>
        `;

        return html`
            <div class="column" data-chat-column>
                ${header}
                <div
                    class="content"
                    ${listen('dragenter', (event) => {
                        if (event.dataTransfer?.types.includes('Files')) {
                            updateState({
                                isDraggingFiles: true,
                            });
                        }
                    })}
                >
                    ${errorBanner} ${isDraft ? draftHero : scroller}
                    ${state.isDraggingFiles
                        ? html`
                              <div
                                  class="drop-overlay"
                                  ${listen('dragover', (event) => {
                                      event.preventDefault();
                                      if (event.dataTransfer) {
                                          event.dataTransfer.dropEffect = 'copy';
                                      }
                                  })}
                                  ${listen('dragleave', () => {
                                      updateState({
                                          isDraggingFiles: false,
                                      });
                                  })}
                                  ${listen('drop', async (event) => {
                                      event.preventDefault();
                                      updateState({
                                          isDraggingFiles: false,
                                      });
                                      const files = event.dataTransfer
                                          ? collectDroppedFiles(event.dataTransfer)
                                          : [];
                                      if (files.length) {
                                          await attachFiles(files);
                                      }
                                  })}
                              >
                                  Drop files to attach
                              </div>
                          `
                        : nothing}
                </div>
            </div>
        `;
    },
});
