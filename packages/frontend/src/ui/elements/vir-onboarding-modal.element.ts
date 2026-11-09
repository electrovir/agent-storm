import {
    addRepoEndpoint,
    checkPathEndpoint,
    claudeHooksInstallEndpoint,
    onboardingEndpoint,
    type OnboardingStatus,
    startAtLoginEndpoint,
} from '@agent-storm/common';
import {type AppContext, defineAppElement, fetchApi} from '@agent-storm/core/frontend';
import {extractErrorMessage, getEnumValues} from '@augment-vir/common';
import {HttpMethod} from '@rest-vir/api';
import {css, html, type HtmlInterpolation, listen, nothing} from 'element-vir';
import {
    ViraButton,
    ViraColorVariant,
    ViraEmphasis,
    ViraInput,
    ViraModal,
    viraThemeByKeys,
} from 'vira';

enum OnboardingStep {
    Folders = 'folders',
    GitHub = 'github',
    ClaudeHooks = 'claude-hooks',
    StartAtLogin = 'start-at-login',
}

type StepParams = Readonly<{
    status: Readonly<OnboardingStatus>;
    repoPaths: ReadonlyArray<string>;
}>;

/** The screens, in order. A screen that isn't available here is left out. */
const onboardingSteps: Readonly<
    Record<
        OnboardingStep,
        Readonly<{
            title: string;
            isAvailable(status: Readonly<OnboardingStatus>): boolean;
            isDone(params: StepParams): boolean;
        }>
    >
> = {
    [OnboardingStep.Folders]: {
        title: 'Add your repos',
        isAvailable() {
            return true;
        },
        isDone({repoPaths}) {
            return !!repoPaths.length;
        },
    },
    [OnboardingStep.GitHub]: {
        title: 'Connect GitHub',
        isAvailable() {
            return true;
        },
        isDone({status}) {
            return status.isGitHubConnected;
        },
    },
    [OnboardingStep.ClaudeHooks]: {
        title: 'Install the Claude Code hooks',
        isAvailable(status) {
            return status.canInstallClaudeHooks;
        },
        isDone({status}) {
            return status.areClaudeHooksInstalled;
        },
    },
    [OnboardingStep.StartAtLogin]: {
        title: 'Start at login',
        isAvailable(status) {
            return status.canStartAtLogin;
        },
        isDone({status}) {
            return status.isStartAtLoginEnabled;
        },
    },
};

/**
 * First-run setup, one screen per step. It opens on its own only until it's finished or skipped,
 * and only while no repo is saved, so existing setups never see it.
 */
export const VirOnboardingModal = defineAppElement<{
    context: AppContext;
}>()({
    tagName: 'vir-onboarding-modal',
    state() {
        return {
            status: undefined as OnboardingStatus | undefined,
            isOpen: false,
            stepIndex: 0,
            repoPaths: [] as ReadonlyArray<string>,
            folderPath: '',
            isBusy: false,
            error: '',
        };
    },
    styles: css`
        .body {
            display: flex;
            flex-direction: column;
            gap: 16px;
            width: min(520px, calc(100vw - 48px));
            max-width: 100%;
            box-sizing: border-box;
            color: ${viraThemeByKeys.grey.foreground.body.foreground.value};
        }

        .step-count,
        .muted {
            font-size: 12px;
            color: ${viraThemeByKeys.grey.foreground['non-body'].foreground.value};
        }

        h3 {
            margin: 0;
        }

        p {
            margin: 0;
        }

        .error {
            font-size: 12px;
            color: ${viraThemeByKeys.red.foreground.body.foreground.value};
        }

        .row {
            display: flex;
            align-items: center;
            gap: 8px;

            & ${ViraInput} {
                flex-grow: 1;
                min-width: 0;
            }
        }

        ul {
            display: flex;
            flex-direction: column;
            gap: 4px;
            margin: 0;
            padding-left: 20px;
            font-size: 13px;
            word-break: break-all;
        }

        .footer {
            display: flex;
            align-items: center;
            gap: 8px;

            & .spacer {
                flex-grow: 1;
            }
        }
    `,
    init({updateState}) {
        async function loadStatus() {
            try {
                const status = await fetchApi(onboardingEndpoint, HttpMethod.Get);
                updateState({
                    status,
                    isOpen: status.shouldShowOnboarding,
                });
            } catch {
                /** Without its status, setup just doesn't open. Settings still offers each step. */
            }
        }
        void loadStatus();
    },
    render({inputs, state, updateState}) {
        const status = state.status;
        if (!status) {
            return nothing;
        }
        const steps = getEnumValues(OnboardingStep).filter((step) => {
            return onboardingSteps[step].isAvailable(status);
        });
        const step = steps[state.stepIndex] ?? OnboardingStep.Folders;
        const isLastStep = state.stepIndex >= steps.length - 1;
        const isStepDone = onboardingSteps[step].isDone({
            status,
            repoPaths: state.repoPaths,
        });

        async function runAction(action: () => Promise<OnboardingStatus | undefined>) {
            if (state.isBusy) {
                return;
            }
            updateState({
                isBusy: true,
                error: '',
            });
            try {
                const updatedStatus = await action();
                updateState({
                    isBusy: false,
                    ...(updatedStatus
                        ? {
                              status: updatedStatus,
                          }
                        : {}),
                });
            } catch (error) {
                updateState({
                    isBusy: false,
                    error: extractErrorMessage(error),
                });
            }
        }

        async function finish() {
            await runAction(async () => {
                const updatedStatus = await fetchApi(onboardingEndpoint, HttpMethod.Post);
                updateState({
                    isOpen: false,
                });
                return updatedStatus;
            });
        }

        async function addFolder() {
            const input = state.folderPath.trim();
            if (!input) {
                return;
            }
            await runAction(async () => {
                const {exists, resolvedPath} = await fetchApi(checkPathEndpoint, HttpMethod.Post, {
                    requestData: {
                        path: input,
                    },
                });
                if (!exists) {
                    throw new Error(`There's no folder at ${resolvedPath}.`);
                }
                const added = await fetchApi(addRepoEndpoint, HttpMethod.Post, {
                    requestData: {
                        path: resolvedPath,
                        aiId: '',
                    },
                });
                updateState({
                    repoPaths: added.repos.map((repo) => repo.path),
                    folderPath: '',
                });
                await inputs.context.folderData.refresh();
                return undefined;
            });
        }

        function renderActionButton({
            text,
            doneText,
            action,
        }: Readonly<{
            text: string;
            doneText: string;
            action: () => Promise<OnboardingStatus | undefined>;
        }>) {
            return isStepDone
                ? html`
                      <span class="muted">${doneText}</span>
                  `
                : html`
                      <div>
                          <${ViraButton.assign({
                              text,
                              color: ViraColorVariant.Brand,
                              isDisabled: state.isBusy,
                          })}
                              ${listen('click', async () => {
                                  await runAction(action);
                              })}
                          ></${ViraButton}>
                      </div>
                  `;
        }

        const stepContent: Readonly<Record<OnboardingStep, () => HtmlInterpolation>> = {
            [OnboardingStep.Folders]() {
                return html`
                    <p>
                        Add the git repos you work in. Each one gets its own terminals and AI tabs
                        in the sidebar, where you can add more later.
                    </p>
                    ${state.repoPaths.length
                        ? html`
                              <ul>
                                  ${state.repoPaths.map((repoPath) => {
                                      return html`
                                          <li>${repoPath}</li>
                                      `;
                                  })}
                              </ul>
                          `
                        : nothing}
                    <div class="row">
                        <${ViraInput.assign({
                            value: state.folderPath,
                            placeholder: '~/repos/my-project',
                        })}
                            ${listen(ViraInput.events.valueChange, (event) => {
                                updateState({
                                    folderPath: event.detail,
                                });
                            })}
                            ${listen('keydown', async (event) => {
                                if (event.key === 'Enter') {
                                    await addFolder();
                                }
                            })}
                        ></${ViraInput}>
                        <${ViraButton.assign({
                            text: 'Add',
                            color: ViraColorVariant.Brand,
                            isDisabled: state.isBusy || !state.folderPath.trim(),
                        })}
                            ${listen('click', addFolder)}
                        ></${ViraButton}>
                    </div>
                `;
            },
            [OnboardingStep.GitHub]() {
                return html`
                    <p>agent-storm shows pull requests and reviews through the GitHub CLI.</p>
                    ${status.isGitHubConnected
                        ? nothing
                        : html`
                              <p>
                                  Run
                                  <code>gh auth login</code>
                                  in a terminal, then check again.
                              </p>
                          `}
                    ${renderActionButton({
                        text: 'Check again',
                        doneText: 'GitHub is connected.',
                        async action() {
                            return await fetchApi(onboardingEndpoint, HttpMethod.Get);
                        },
                    })}
                `;
            },
            [OnboardingStep.ClaudeHooks]() {
                return html`
                    <p>
                        The hooks let each AI tab resume its own conversation and show when Claude
                        is working. Installing them adds entries to
                        <code>~/.claude/settings.json</code>
                        beside your own hooks.
                    </p>
                    ${renderActionButton({
                        text: 'Install',
                        doneText: 'The hooks are installed.',
                        async action() {
                            return await fetchApi(claudeHooksInstallEndpoint, HttpMethod.Post);
                        },
                    })}
                `;
            },
            [OnboardingStep.StartAtLogin]() {
                return html`
                    <p>
                        Start agent-storm in the background when you log in, so it's already running
                        when you open it. You can turn this off in Settings.
                    </p>
                    ${renderActionButton({
                        text: 'Turn on',
                        doneText: 'agent-storm starts at login.',
                        async action() {
                            return await fetchApi(startAtLoginEndpoint, HttpMethod.Post, {
                                requestData: {
                                    isEnabled: true,
                                },
                            });
                        },
                    })}
                `;
            },
        };

        return html`
            <${ViraModal.assign({
                open: state.isOpen,
                modalTitle: 'Set up agent-storm',
                blockLightDismissal: true,
            })}
                ${listen(ViraModal.events.modalClose, () => {
                    /**
                     * Vira also closes on its close button, Escape, browser Back, and a page
                     * restore. Only Skip and Done finish setup, so any other close opens it again
                     * on the next load.
                     */
                    updateState({
                        isOpen: false,
                    });
                })}
            >
                <div class="body">
                    <span class="step-count">Step ${state.stepIndex + 1} of ${steps.length}</span>
                    <h3>${onboardingSteps[step].title}</h3>
                    ${stepContent[step]()}
                    ${state.error
                        ? html`
                              <span class="error">${state.error}</span>
                          `
                        : nothing}
                    <div class="footer">
                        ${state.stepIndex
                            ? nothing
                            : html`
                                  <${ViraButton.assign({
                                      text: 'Skip setup',
                                      color: ViraColorVariant.Neutral,
                                      buttonEmphasis: ViraEmphasis.Subtle,
                                      isDisabled: state.isBusy,
                                  })}
                                      ${listen('click', finish)}
                                  ></${ViraButton}>
                              `}
                        <span class="spacer"></span>
                        <${ViraButton.assign({
                            text: isStepDone ? (isLastStep ? 'Done' : 'Next') : 'Skip',
                            color: isStepDone ? ViraColorVariant.Brand : ViraColorVariant.Neutral,
                            isDisabled: state.isBusy,
                        })}
                            ${listen('click', async () => {
                                if (state.isBusy) {
                                    return;
                                }
                                if (isLastStep) {
                                    await finish();
                                } else {
                                    updateState({
                                        stepIndex: state.stepIndex + 1,
                                        error: '',
                                    });
                                }
                            })}
                        ></${ViraButton}>
                    </div>
                </div>
            </${ViraModal}>
        `;
    },
});
