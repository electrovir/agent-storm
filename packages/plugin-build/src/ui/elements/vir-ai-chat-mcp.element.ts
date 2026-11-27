import {defineAppElement} from '@agent-storm/core/frontend';
import {extractErrorMessage, wait} from '@augment-vir/common';
import {css, defineElementEvent, html, listen, nothing} from 'element-vir';
import {
    createSizedIcon,
    LucideLogInIcon,
    LucidePlugIcon,
    LucideRotateCwIcon,
    PopoverAnchor,
    PopoverTrigger,
    tooltip,
    ViraButton,
    ViraCheckbox,
    ViraColorVariant,
    ViraEmphasis,
    ViraIcon,
    ViraInput,
    ViraLink,
    ViraPopoverTrigger,
    viraShadows,
    ViraSize,
    ViraTag,
    viraThemeByKeys,
    type PopoverManager,
    type ViraThemeColorName,
} from 'vira';
import {McpServerState, type McpServer} from '../../build-api.js';
import {buildClient} from '../../util/build-client.js';

const mcpStateDisplays: Readonly<
    Record<
        McpServerState,
        Readonly<{
            label: string;
            tagColor: ViraThemeColorName;
        }>
    >
> = {
    [McpServerState.Connected]: {
        label: 'Connected',
        tagColor: 'green',
    },
    [McpServerState.Pending]: {
        label: 'Connecting',
        tagColor: 'blue',
    },
    [McpServerState.Failed]: {
        label: 'Failed',
        tagColor: 'red',
    },
    [McpServerState.NeedsAuth]: {
        label: 'Needs sign-in',
        tagColor: 'yellow',
    },
    [McpServerState.Disabled]: {
        label: 'Off',
        tagColor: 'grey',
    },
};

const plugIcon = createSizedIcon(LucidePlugIcon, 14);
const reconnectIcon = createSizedIcon(LucideRotateCwIcon, 14);
const signInIcon = createSizedIcon(LucideLogInIcon, 14);

/**
 * The composer chip that lists the MCP servers a thread's agent sees, with a checkbox that turns
 * each on or off, a button that connects it again, and one that signs in to a server that needs it.
 * The chat opens it with `isOpen`, such as when the user sends `/mcp`.
 */
export const VirAiChatMcp = defineAppElement<{
    threadId: string;
    isOpen: boolean;
}>()({
    tagName: 'vir-ai-chat-mcp',
    events: {
        openChange: defineElementEvent<boolean>(),
    },
    state() {
        return {
            wasOpen: false,
            /** Unset until the first list arrives. */
            servers: undefined as McpServer[] | undefined,
            error: '',
            /** The server whose change is in flight. Empty for none. */
            busyServerName: '',
            isPolling: false,
            mountController: new AbortController(),
            /** The sign-in the user started, until its server stops needing one. */
            signIn: undefined as
                | Readonly<{
                      threadId: string;
                      serverName: string;
                      authUrl: string;
                      isCallbackExpected: boolean;
                  }>
                | undefined,
            /** The localhost address a sign-in page redirected to, as the user pasted it. */
            callbackUrl: '',
            /** Opens and closes the popover, once the popover trigger has started. */
            popoverManager: undefined as PopoverManager | undefined,
        };
    },
    styles() {
        const textColor = viraThemeByKeys.grey.foreground.body.foreground.value;
        const mutedColor = viraThemeByKeys.grey.foreground['non-body'].foreground.value;
        const selectedBackground = viraThemeByKeys.grey['behind-fg']['small-body'].background.value;

        return css`
            :host {
                display: flex;
                flex-shrink: 0;
                font-size: 14px;
                color: ${textColor};
            }

            .chip {
                display: inline-flex;
                align-items: center;
                gap: 6px;
                height: 28px;
                padding: 0 8px 0 6px;
                border-radius: 8px;
                font-weight: 500;
                white-space: nowrap;
                color: ${mutedColor};

                &:hover,
                &.open {
                    background-color: ${selectedBackground};
                    color: ${textColor};
                }
            }

            .popover {
                display: flex;
                flex-direction: column;
                gap: 8px;
                width: 340px;
                max-width: calc(100vw - 32px);
                max-height: min(420px, 60vh);
                min-height: 0;
                box-sizing: border-box;
                padding: 8px;
                border-radius: 8px;
                border: 1px solid ${viraThemeByKeys.grey.foreground.decoration.foreground.value};
                background-color: ${viraThemeByKeys.grey['behind-bg'].body.foreground.value};
                ${viraShadows.menuShadow}
            }

            .heading {
                font-size: 12px;
                font-weight: 500;
                color: ${mutedColor};
            }

            .servers {
                display: flex;
                flex-direction: column;
                gap: 8px;
                overflow-y: auto;
                min-height: 0;
            }

            .server {
                display: flex;
                align-items: flex-start;
                gap: 8px;

                & ${ViraCheckbox} {
                    flex-shrink: 0;
                }
            }

            .details {
                display: flex;
                flex-direction: column;
                flex-grow: 1;
                gap: 2px;
                min-width: 0;
                font-size: 13px;
            }

            .name-row {
                display: flex;
                align-items: center;
                gap: 6px;
                min-width: 0;

                & .name {
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                    font-weight: 500;
                }

                & ${ViraTag} {
                    flex-shrink: 0;
                }
            }

            .muted {
                color: ${mutedColor};
                font-size: 12px;
            }

            .sign-in {
                display: flex;
                flex-direction: column;
                gap: 4px;
                margin-top: 4px;
            }

            .callback-row {
                display: flex;
                align-items: center;
                gap: 4px;

                & ${ViraInput} {
                    flex-grow: 1;
                    min-width: 0;
                }
            }

            .error {
                color: ${viraThemeByKeys.red.foreground.body.foreground.value};
                font-size: 12px;
                overflow-wrap: anywhere;
            }
        `;
    },
    cleanup({state}) {
        state.mountController.abort();
    },
    render({inputs, state, updateState, dispatch, events}) {
        const threadId = inputs.threadId;
        /** The state proxy is reused on reconnect, so capture this mount's signal. */
        const mountSignal = state.mountController.signal;

        function isCurrentThread() {
            return !mountSignal.aborted && inputs.threadId === threadId;
        }

        /** Whether the user started signing in to one of `servers` that still needs it. */
        function isAwaitingSignIn(servers: ReadonlyArray<Readonly<McpServer>>) {
            return (
                state.signIn?.threadId === inputs.threadId &&
                servers.some((server) => {
                    return (
                        server.name === state.signIn?.serverName &&
                        server.state === McpServerState.NeedsAuth
                    );
                })
            );
        }

        async function showReply(
            call: () => Promise<
                Readonly<{
                    servers: McpServer[];
                    error: string;
                }>
            >,
        ) {
            try {
                const reply = await call();
                if (!isCurrentThread()) {
                    return undefined;
                }
                updateState({
                    servers: reply.servers,
                    error: reply.error,
                });
                if (!isAwaitingSignIn(reply.servers)) {
                    updateState({
                        signIn: undefined,
                        callbackUrl: '',
                    });
                }
                return reply.servers;
            } catch (error) {
                if (isCurrentThread()) {
                    updateState({
                        error: extractErrorMessage(error),
                    });
                }
                return undefined;
            }
        }

        /**
         * A running session connects its servers, and finishes a sign-in, in the background, so
         * they're read until done.
         */
        async function pollWhilePending(servers: ReadonlyArray<Readonly<McpServer>> | undefined) {
            if (
                !isCurrentThread() ||
                state.isPolling ||
                !servers ||
                !(
                    servers.some((server) => server.state === McpServerState.Pending) ||
                    isAwaitingSignIn(servers)
                )
            ) {
                return;
            }
            updateState({
                isPolling: true,
            });
            await wait({
                seconds: 2,
            });
            const next =
                isCurrentThread() && inputs.isOpen
                    ? await showReply(() => {
                          return buildClient.call('listMcpServers', {
                              threadId,
                              isNewServerLoadEnabled: false,
                          });
                      })
                    : undefined;
            if (mountSignal.aborted) {
                return;
            }
            updateState({
                isPolling: false,
            });
            await pollWhilePending(next);
        }

        async function changeServer({
            serverName,
            call,
        }: Readonly<{
            serverName: string;
            call: () => Promise<
                Readonly<{
                    servers: McpServer[];
                    error: string;
                }>
            >;
        }>) {
            updateState({
                busyServerName: serverName,
                error: '',
            });
            const servers = await showReply(call);
            if (mountSignal.aborted) {
                return;
            }
            updateState({
                busyServerName: '',
            });
            await pollWhilePending(servers);
        }

        if (inputs.isOpen !== state.wasOpen) {
            updateState({
                wasOpen: inputs.isOpen,
            });
            if (inputs.isOpen) {
                updateState({
                    error: '',
                });
                void showReply(() => {
                    return buildClient.call('listMcpServers', {
                        threadId,
                        isNewServerLoadEnabled: true,
                    });
                }).then(pollWhilePending);
            }
        }

        const serverRows = state.servers?.map((server) => {
            const display = mcpStateDisplays[server.state];
            const isBusy = !!state.busyServerName;
            const isEnabled = server.state !== McpServerState.Disabled;
            const signIn =
                state.signIn?.threadId === threadId && state.signIn.serverName === server.name
                    ? state.signIn
                    : undefined;
            return html`
                <div class="server">
                    <${ViraCheckbox.assign({
                        value: isEnabled,
                        isDisabled: isBusy,
                    })}
                        ${tooltip(isEnabled ? `Turn off ${server.name}` : `Turn on ${server.name}`)}
                        ${listen(ViraCheckbox.events.valueChange, async (event) => {
                            if (isBusy) {
                                return;
                            }
                            await changeServer({
                                serverName: server.name,
                                call() {
                                    return buildClient.call('setMcpServerEnabled', {
                                        threadId,
                                        serverName: server.name,
                                        isEnabled: event.detail,
                                    });
                                },
                            });
                        })}
                    ></${ViraCheckbox}>
                    <div class="details">
                        <div class="name-row">
                            <span class="name">${server.name}</span>
                            <${ViraTag.assign({
                                text:
                                    state.busyServerName === server.name
                                        ? 'Working…'
                                        : display.label,
                                size: ViraSize.Small,
                                color: display.tagColor,
                            })}></${ViraTag}>
                        </div>
                        <span class="muted">
                            ${[
                                server.scope,
                                server.state === McpServerState.Connected
                                    ? `${server.toolCount} ${server.toolCount === 1 ? 'tool' : 'tools'}`
                                    : '',
                            ]
                                .filter((part) => !!part)
                                .join(' · ')}
                        </span>
                        ${server.error
                            ? html`
                                  <span class="error">${server.error}</span>
                              `
                            : nothing}
                        ${signIn
                            ? html`
                                  <div class="sign-in">
                                      <${ViraLink.assign({
                                          link: {
                                              url: signIn.authUrl,
                                              newTab: true,
                                          },
                                      })}>
                                          Open sign-in page
                                      </${ViraLink}>
                                      ${signIn.isCallbackExpected
                                          ? html`
                                                <span class="muted">
                                                    If sign-in ends on a localhost page that won't
                                                    load, paste that page's address here.
                                                </span>
                                                <div class="callback-row">
                                                    <${ViraInput.assign({
                                                        value: state.callbackUrl,
                                                        placeholder: 'http://localhost:…',
                                                        disableBrowserHelps: true,
                                                        disabled: isBusy,
                                                    })}
                                                        ${listen(
                                                            ViraInput.events.valueChange,
                                                            (event) => {
                                                                updateState({
                                                                    callbackUrl: event.detail,
                                                                });
                                                            },
                                                        )}
                                                    ></${ViraInput}>
                                                    <${ViraButton.assign({
                                                        text: 'Finish',
                                                        buttonSize: ViraSize.Small,
                                                        isDisabled:
                                                            isBusy || !state.callbackUrl.trim(),
                                                    })}
                                                        ${listen('click', async () => {
                                                            const callbackUrl =
                                                                state.callbackUrl.trim();
                                                            if (isBusy || !callbackUrl) {
                                                                return;
                                                            }
                                                            await changeServer({
                                                                serverName: server.name,
                                                                call() {
                                                                    return buildClient.call(
                                                                        'submitMcpSignInCallback',
                                                                        {
                                                                            threadId,
                                                                            serverName: server.name,
                                                                            callbackUrl,
                                                                        },
                                                                    );
                                                                },
                                                            });
                                                        })}
                                                    ></${ViraButton}>
                                                </div>
                                            `
                                          : html`
                                                <span class="muted">
                                                    Reconnect it once you've signed in.
                                                </span>
                                            `}
                                  </div>
                              `
                            : nothing}
                    </div>
                    ${server.state === McpServerState.NeedsAuth
                        ? html`
                              <${ViraButton.assign({
                                  icon: signInIcon,
                                  color: ViraColorVariant.Neutral,
                                  buttonEmphasis: ViraEmphasis.Subtle,
                                  buttonSize: ViraSize.Small,
                                  isDisabled: isBusy,
                              })}
                                  ${tooltip(`Sign in to ${server.name}`)}
                                  aria-label=${`Sign in to ${server.name}`}
                                  ${listen('click', async () => {
                                      if (isBusy) {
                                          return;
                                      }
                                      await changeServer({
                                          serverName: server.name,
                                          async call() {
                                              const reply = await buildClient.call(
                                                  'signInMcpServer',
                                                  {
                                                      threadId,
                                                      serverName: server.name,
                                                  },
                                              );
                                              if (isCurrentThread()) {
                                                  updateState({
                                                      callbackUrl: '',
                                                      signIn: reply.authUrl
                                                          ? {
                                                                threadId,
                                                                serverName: server.name,
                                                                authUrl: reply.authUrl,
                                                                isCallbackExpected:
                                                                    reply.isCallbackExpected,
                                                            }
                                                          : undefined,
                                                  });
                                              }
                                              return reply;
                                          },
                                      });
                                  })}
                              ></${ViraButton}>
                          `
                        : nothing}
                    ${isEnabled
                        ? html`
                              <${ViraButton.assign({
                                  icon: reconnectIcon,
                                  color: ViraColorVariant.Neutral,
                                  buttonEmphasis: ViraEmphasis.Subtle,
                                  buttonSize: ViraSize.Small,
                                  isDisabled: isBusy,
                              })}
                                  ${tooltip(`Reconnect ${server.name}`)}
                                  aria-label=${`Reconnect ${server.name}`}
                                  ${listen('click', async () => {
                                      if (isBusy) {
                                          return;
                                      }
                                      await changeServer({
                                          serverName: server.name,
                                          call() {
                                              return buildClient.call('reconnectMcpServer', {
                                                  threadId,
                                                  serverName: server.name,
                                              });
                                          },
                                      });
                                  })}
                              ></${ViraButton}>
                          `
                        : nothing}
                </div>
            `;
        });

        const connectedCount =
            state.servers?.filter((server) => server.state === McpServerState.Connected).length ??
            0;

        /** Opens or closes the popover when the chat changes `isOpen`, such as for `/mcp`. */
        const popoverManager = state.popoverManager;
        if (popoverManager && popoverManager.isOpen() !== inputs.isOpen) {
            /** Waits for the trigger to render, since a popover that isn't in the page can't open. */
            queueMicrotask(() => {
                if (inputs.isOpen) {
                    popoverManager.show();
                } else {
                    popoverManager.hide();
                }
            });
        }

        return html`
            <${ViraPopoverTrigger.assign({
                trigger: PopoverTrigger.Click,
                popoverAnchor: PopoverAnchor.Left,
                keepOpenAfterInteraction: true,
                useInsideFocus: true,
                popoverOffset: {
                    vertical: 4,
                },
            })}
                ${listen(ViraPopoverTrigger.events.init, (event) => {
                    updateState({
                        popoverManager: event.detail.popoverManager,
                    });
                })}
                ${listen(ViraPopoverTrigger.events.openChange, (event) => {
                    dispatch(
                        new events.openChange({
                            detail: event.detail,
                        }),
                    );
                })}
            >
                <span
                    class="chip ${inputs.isOpen ? 'open' : ''}"
                    slot=${ViraPopoverTrigger.slotNames['vira-popover-trigger-trigger']}
                    aria-label="MCP servers"
                    ${tooltip('MCP servers')}
                >
                    <${ViraIcon.assign({
                        icon: plugIcon,
                    })}></${ViraIcon}>
                    <span>
                        ${state.servers && connectedCount < state.servers.length
                            ? `MCP ${connectedCount}/${state.servers.length}`
                            : 'MCP'}
                    </span>
                </span>
                ${inputs.isOpen
                    ? html`
                          <div
                              class="popover"
                              slot=${ViraPopoverTrigger.slotNames['vira-popover-trigger-popover']}
                              role="dialog"
                              aria-label="MCP servers"
                          >
                              <div class="heading">MCP servers</div>
                              ${state.error
                                  ? html`
                                        <span class="error">${state.error}</span>
                                    `
                                  : nothing}
                              ${serverRows
                                  ? serverRows.length
                                      ? html`
                                            <div class="servers">${serverRows}</div>
                                        `
                                      : html`
                                            <span class="muted">
                                                No MCP servers are set up here.
                                            </span>
                                        `
                                  : html`
                                        <span class="muted">Connecting to MCP servers…</span>
                                    `}
                              <span class="muted">
                                  Turning a server on or off also applies to new chats in this
                                  folder.
                              </span>
                          </div>
                      `
                    : nothing}
            </${ViraPopoverTrigger}>
        `;
    },
});
