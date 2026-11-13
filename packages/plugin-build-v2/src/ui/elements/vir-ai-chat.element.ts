import {defineAppElement, type AppContext} from '@agent-storm/core/frontend';
import {extractErrorMessage, getEnumValues} from '@augment-vir/common';
import {classMap, css, defineElementEvent, html, listen, nothing} from 'element-vir';
import {
    createSizedIcon,
    LucideCircleAlertIcon,
    LucideGitBranchIcon,
    ViraButton,
    ViraColorVariant,
    ViraIcon,
    ViraSize,
    ViraTag,
    viraThemeByKeys,
} from 'vira';
import {
    AiProvider,
    ThreadStatus,
    type ApprovalDecision,
    type ApprovalRequest,
    type ReasoningEffort,
    type Thread,
    type ThreadItem,
} from '../../build-v2-api.js';
import {buildV2Client} from '../../util/build-v2-client.js';
import {applyItemDelta, findPathName, upsertItems} from '../../util/thread-timeline.js';
import {renderProjectMonogram} from './sidebar-project-icon.js';
import {providerLabels, threadStatusDisplays} from './thread-display.js';
import {VirAiChatApproval} from './vir-ai-chat-approval.element.js';
import {VirAiChatComposer} from './vir-ai-chat-composer.element.js';
import {type ProviderModelList} from './vir-ai-chat-model-picker.element.js';
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
}>()({
    tagName: 'vir-ai-chat',
    events: {
        threadCreated: defineElementEvent<Thread>(),
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
            provider: AiProvider.Claude,
            /** The model a new thread starts with. Empty for the provider's default. */
            model: '',
            /** The reasoning effort a new thread starts with. Unset for the model's default. */
            effort: undefined as ReasoningEffort | undefined,
            providerModels: {} as Readonly<Partial<Record<AiProvider, ProviderModelList>>>,
            isSending: false,
            /** The request whose answer is being sent. */
            busyRequestId: undefined as string | undefined,
            isMoving: false,
            removers: [] as ReadonlyArray<() => Promise<void>>,
            removeReconnectListener: (() => {}) as () => void,
        };
    },
    init({inputs, updateState, host}) {
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
                })
                .catch((error: unknown) => {
                    updateState({
                        error: extractErrorMessage(error),
                        isLoading: false,
                    });
                });
        }
        readThread(threadId);
        updateState({
            removeReconnectListener: buildV2Client.listenToReconnect(() => {
                readThread(threadId);
            }),
        });
    },
    cleanup({state}) {
        state.removeReconnectListener();
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
                    gap: 6px;
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
            background-color: ${viraThemeByKeys.grey['behind-bg'].body.foreground.value};
            background-image: linear-gradient(
                ${viraThemeByKeys.red['behind-fg']['lowest-contrast'].background.value},
                ${viraThemeByKeys.red['behind-fg']['lowest-contrast'].background.value}
            );
            color: ${viraThemeByKeys.red.foreground.body.foreground.value};
            pointer-events: auto;

            & vira-icon {
                flex-shrink: 0;
                margin-top: 2px;
            }

            & .error-body {
                display: flex;
                flex-direction: column;
                align-items: flex-start;
                gap: 4px;
                min-width: 0;
            }

            & .error-text {
                white-space: pre-wrap;
                overflow-wrap: anywhere;

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
                display: flex;
                justify-content: center;
                align-items: baseline;
                gap: 8px;
                margin: 0;
                font-size: 24px;
                font-weight: 400;
                letter-spacing: -0.025em;
                text-align: center;

                @media (min-width: 640px) {
                    font-size: 30px;
                }

                & .repo-name {
                    font-weight: 500;
                }
            }
        }
    `,
    render({inputs, state, updateState, dispatch, events}) {
        const isDraft = !inputs.threadId;
        const isRunning = state.thread?.status === ThreadStatus.Running;
        const status = state.thread ? threadStatusDisplays[state.thread.status] : undefined;
        const cwd = state.thread?.cwd || inputs.repoPath;
        const branch =
            state.thread?.worktreeBranch ||
            inputs.context.folderData.value.folderInfo.get(cwd)?.branch;
        const canMoveToWorktree = !!state.thread && !state.thread.worktreeBranch;
        const request = state.requests[0];

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

        async function send(text: string) {
            updateState({
                isSending: true,
            });
            await runAction(async () => {
                if (inputs.threadId) {
                    await buildV2Client.call('sendMessage', {
                        threadId: inputs.threadId,
                        text,
                    });
                    updateState({
                        composerText: '',
                    });
                } else {
                    const {thread} = await buildV2Client.call('createThread', {
                        repoPath: inputs.repoPath,
                        provider: state.provider,
                        model: state.model,
                        effort: state.effort,
                        text,
                    });
                    updateState({
                        composerText: '',
                    });
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

        async function decide(requestId: string, decision: ApprovalDecision) {
            updateState({
                busyRequestId: requestId,
            });
            await runAction(async () => {
                await buildV2Client.call('resolveRequest', {
                    requestId,
                    decision,
                });
                updateState({
                    requests: state.requests.filter((existing) => existing.id !== requestId),
                });
            });
            updateState({
                busyRequestId: undefined,
            });
        }

        const composer = html`
            <${VirAiChatComposer.assign({
                text: state.composerText,
                placeholder: isDraft ? 'Ask anything…' : 'Ask for follow-up changes…',
                isRunning,
                isBusy: state.isSending,
                providerModels: state.providerModels,
                /** A thread keeps the provider it started with. */
                providers: state.thread
                    ? [
                          state.thread.provider,
                      ]
                    : getEnumValues(AiProvider),
                provider: state.thread?.provider || state.provider,
                model: state.thread ? state.thread.model : state.model,
                effort: state.thread ? state.thread.effort || undefined : state.effort,
            })}
                ${listen(VirAiChatComposer.events.textChange, (event) => {
                    updateState({
                        composerText: event.detail,
                    });
                })}
                ${listen(VirAiChatComposer.events.modelChange, async (event) => {
                    const threadId = inputs.threadId;
                    if (!threadId) {
                        updateState({
                            provider: event.detail.provider,
                            model: event.detail.model,
                            effort: event.detail.effort,
                        });
                        return;
                    }
                    await runAction(async () => {
                        const {thread} = await buildV2Client.call('setThreadModel', {
                            threadId,
                            model: event.detail.model,
                            effort: event.detail.effort,
                        });
                        updateState({
                            thread,
                        });
                    });
                })}
                ${listen(VirAiChatComposer.events.submitted, async (event) => {
                    await send(event.detail);
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
            ></${VirAiChatComposer}>
        `;

        const projectPath = state.thread?.repoPath || inputs.repoPath;
        const projectName = projectPath ? findPathName(projectPath) : '';

        const header = html`
            <header data-chat-header>
                <nav aria-label="Thread breadcrumb">
                    <ol>
                        <li class="project">
                            ${renderProjectMonogram({
                                projectName,
                                size: 14,
                            })}
                            <span class="crumb project-name" title=${cwd}>${projectName}</span>
                        </li>
                        <li class="separator" aria-hidden="true">/</li>
                        <li class="title" aria-current="page">
                            <h2
                                aria-label=${state.thread?.title || 'New thread'}
                                title=${state.thread?.title || ''}
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
                    ${state.thread
                        ? html`
                              <${ViraTag.assign({
                                  text: providerLabels[state.thread.provider],
                                  size: ViraSize.Small,
                                  color: ViraColorVariant.Neutral,
                              })}></${ViraTag}>
                          `
                        : nothing}
                    ${branch
                        ? html`
                              <span class="branch" title=${cwd}>
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
                                  title="Continue this thread in a new worktree of its own"
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
                                  ${state.error}
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

        const approval = request
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
                <div class="lane-content">${composer}</div>
            </div>
        `;

        const draftHero = html`
            <div class="lane draft">
                <div class="lane-content hero-anchor">
                    <div class="hero">
                        <h1>
                            <span>What should we build in</span>
                            <span>
                                <span class="repo-name">${findPathName(inputs.repoPath)}</span>
                                ?
                            </span>
                        </h1>
                    </div>
                    ${composer}
                </div>
            </div>
        `;

        return html`
            <div class="column" data-chat-column>
                ${header}
                <div class="content">${errorBanner} ${isDraft ? draftHero : scroller}</div>
            </div>
        `;
    },
});
