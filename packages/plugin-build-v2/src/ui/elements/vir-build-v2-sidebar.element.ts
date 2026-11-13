import {defineAppElement, type ActivityRoute, type AppContext} from '@agent-storm/core/frontend';
import {extractErrorMessage} from '@augment-vir/common';
import {classMap, css, html, listen, nothing} from 'element-vir';
import {
    createSizedIcon,
    LucideChevronDownIcon,
    LucideSquarePenIcon,
    ViraIcon,
    viraThemeByKeys,
} from 'vira';
import {type Thread} from '../../build-v2-api.js';
import {buildV2Client} from '../../util/build-v2-client.js';
import {buildV2Memory} from '../../util/build-v2-memory.js';
import {
    findThreadRepos,
    loadThreads,
    newThreadSubPath,
    storeThread,
    type BuildV2State,
} from '../../util/build-v2-state.js';
import {groupThreadsByRepo} from '../../util/thread-timeline.js';
import {renderProjectMonogram} from './sidebar-project-icon.js';
import {sidebarStatusDisplays} from './thread-display.js';
import {VirBuildV2ThreadRow} from './vir-build-v2-thread-row.element.js';

const chevronIcon = createSizedIcon(LucideChevronDownIcon, 12);
const newThreadIcon = createSizedIcon(LucideSquarePenIcon, 14);

/** The Build V2 tab's sidebar: every thread, grouped under its repo, with a new-thread button each. */
export const VirBuildV2Sidebar = defineAppElement<{
    context: AppContext;
    route: ActivityRoute;
    buildV2State: Readonly<BuildV2State>;
}>()({
    tagName: 'vir-build-v2-sidebar',
    state() {
        return {
            actionError: undefined as string | undefined,
            collapsedRepoPaths: [] as ReadonlyArray<string>,
        };
    },
    styles: css`
        :host {
            display: flex;
            flex-direction: column;
            min-height: 0;
            overflow-y: auto;
        }

        .sidebar {
            display: flex;
            box-sizing: border-box;
            flex-direction: column;
            flex-grow: 1;
            width: 100%;
            min-width: 0;
            padding: 8px;
        }

        .message {
            padding: 4px 8px;
            font-size: 12px;
            overflow-wrap: anywhere;
            color: ${viraThemeByKeys.grey.foreground['non-body'].foreground.value};

            &.error {
                display: flex;
                flex-direction: column;
                align-items: flex-start;
                gap: 6px;
                color: ${viraThemeByKeys.red.foreground.body.foreground.value};
            }
        }

        .retry {
            height: 24px;
            padding: 0 8px;
            border: 1px solid ${viraThemeByKeys.grey.foreground.decoration.foreground.value};
            border-radius: 6px;
            background-color: ${viraThemeByKeys.grey['behind-bg'].body.foreground.value};
            font: inherit;
            font-size: 12px;
            cursor: pointer;
            color: ${viraThemeByKeys.grey.foreground.body.foreground.value};

            &:hover {
                background-color: ${viraThemeByKeys.grey['behind-fg']['highest-contrast'].background
                    .value};
            }
        }

        ul {
            display: flex;
            flex-direction: column;
            gap: 1px;
            margin: 0;
            padding: 0;
            list-style: none;
        }

        li {
            list-style: none;
        }

        .project {
            position: relative;
            padding-top: 8px;

            &:first-child {
                padding-top: 0;
            }
        }

        .project-header {
            display: flex;
            box-sizing: border-box;
            width: 100%;
            height: 32px;
            align-items: center;
            gap: 10px;
            padding: 0 8px;
            border: none;
            border-radius: 6px;
            background: transparent;
            font: inherit;
            text-align: left;
            cursor: pointer;
            outline: none;
            color: ${viraThemeByKeys.grey.foreground.body.foreground.value};

            &:hover {
                background-color: ${viraThemeByKeys.grey['behind-fg']['highest-contrast'].background
                    .value};
            }

            &:focus-visible {
                outline: 2px solid ${viraThemeByKeys.blue.foreground.body.foreground.value};
                outline-offset: -2px;
            }

            &.drafting {
                background-color: ${viraThemeByKeys.grey['behind-fg']['small-body'].background
                    .value};
            }
        }

        .project-name {
            flex-grow: 1;
            min-width: 0;
            overflow: hidden;
            white-space: nowrap;
            text-overflow: ellipsis;
            font-size: 14px;
            font-weight: 500;
        }

        .folder-dot {
            width: 6px;
            height: 6px;
            flex-shrink: 0;
            border-radius: 50%;
        }

        .screen-reader-only {
            position: absolute;
            width: 1px;
            height: 1px;
            overflow: hidden;
            clip-path: inset(50%);
            white-space: nowrap;
        }

        .thread-count {
            flex-shrink: 0;
            font-size: 12px;
            font-variant-numeric: tabular-nums;
            color: ${viraThemeByKeys.grey.foreground['non-body'].foreground.value};
        }

        .chevron {
            display: inline-flex;
            flex-shrink: 0;
            transition: transform 120ms;
            color: ${viraThemeByKeys.grey.foreground['non-body'].foreground.value};

            &.collapsed {
                transform: rotate(-90deg);
            }
        }

        .new-thread-wrapper {
            position: absolute;
            top: 8px;
            right: 24px;
            bottom: 0;
            display: flex;
            align-items: center;
            opacity: 0;
        }

        .project:first-child .new-thread-wrapper {
            top: 0;
        }

        .project:hover .new-thread-wrapper,
        .new-thread-wrapper:focus-within {
            opacity: 1;
        }

        .project:hover .thread-count {
            visibility: hidden;
        }

        @media (pointer: coarse) {
            & .new-thread-wrapper {
                opacity: 1;
            }

            & .thread-count {
                visibility: hidden;
            }
        }

        .new-thread {
            display: inline-flex;
            width: 24px;
            height: 24px;
            align-items: center;
            justify-content: center;
            border: none;
            border-radius: 6px;
            background: transparent;
            cursor: pointer;
            outline: none;
            color: ${viraThemeByKeys.grey.foreground['non-body'].foreground.value};

            &:hover {
                background-color: ${viraThemeByKeys.grey['behind-fg']['highest-contrast'].background
                    .value};
                color: ${viraThemeByKeys.grey.foreground.body.foreground.value};
            }

            &:focus-visible {
                outline: 2px solid ${viraThemeByKeys.blue.foreground.body.foreground.value};
                outline-offset: -2px;
            }
        }
    `,
    render({inputs, state, updateState}) {
        const threads = inputs.buildV2State.threads.value;
        const loadError = inputs.buildV2State.loadError.value;
        const draftRepoPath = inputs.buildV2State.draftRepoPath.value;
        const activeThreadId =
            inputs.route.subPaths[0] === newThreadSubPath ? undefined : inputs.route.subPaths[0];
        const groups = groupThreadsByRepo({
            repos: findThreadRepos(inputs.context),
            threads: threads || [],
        });

        async function runAction(action: () => Promise<void>) {
            try {
                updateState({
                    actionError: undefined,
                });
                await action();
            } catch (error) {
                updateState({
                    actionError: extractErrorMessage(error),
                });
            }
        }

        function selectThread(thread: Readonly<Thread>) {
            inputs.buildV2State.draftRepoPath.setValue(undefined);
            buildV2Memory.selectedThread.write(thread.id);
            inputs.route.navigate([
                thread.id,
            ]);
        }

        return html`
            <div class="sidebar">
                ${loadError
                    ? html`
                          <div class="message error">
                              Can't load threads: ${loadError}
                              <button
                                  type="button"
                                  class="retry"
                                  ${listen('click', async () => {
                                      await loadThreads(inputs.buildV2State);
                                  })}
                              >
                                  Retry
                              </button>
                          </div>
                      `
                    : nothing}
                ${state.actionError
                    ? html`
                          <div class="message error">${state.actionError}</div>
                      `
                    : nothing}
                ${threads || loadError
                    ? nothing
                    : html`
                          <div class="message">Loading threads…</div>
                      `}
                ${groups.length || !threads
                    ? nothing
                    : html`
                          <div class="message">
                              No projects yet. Add a folder to start a thread in it.
                          </div>
                      `}
                <ul>
                    ${groups.map((group) => {
                        const isCollapsed = state.collapsedRepoPaths.includes(group.repo.path);
                        const isDrafting =
                            draftRepoPath === group.repo.path &&
                            inputs.route.subPaths[0] === newThreadSubPath;
                        const folderDot = isCollapsed
                            ? group.threads
                                  .map((thread) => sidebarStatusDisplays[thread.status].folderDot)
                                  .find((dot) => dot)
                            : undefined;
                        return html`
                            <li class="project">
                                <button
                                    type="button"
                                    class=${classMap({
                                        'project-header': true,
                                        drafting: isDrafting,
                                    })}
                                    aria-expanded=${!isCollapsed}
                                    title=${group.repo.path}
                                    ${listen('click', () => {
                                        updateState({
                                            collapsedRepoPaths: isCollapsed
                                                ? state.collapsedRepoPaths.filter(
                                                      (path) => path !== group.repo.path,
                                                  )
                                                : [
                                                      ...state.collapsedRepoPaths,
                                                      group.repo.path,
                                                  ],
                                        });
                                    })}
                                >
                                    ${renderProjectMonogram({
                                        projectName: group.repo.name,
                                    })}
                                    <span class="project-name">${group.repo.name}</span>
                                    ${folderDot
                                        ? html`
                                              <span
                                                  class="folder-dot"
                                                  style=${css`
                                                      background-color: ${viraThemeByKeys[
                                                          folderDot.color
                                                      ].foreground.body.foreground.value};
                                                  `}
                                              >
                                                  <span class="screen-reader-only">
                                                      ${folderDot.label}
                                                  </span>
                                              </span>
                                          `
                                        : nothing}
                                    ${isCollapsed && group.threads.length
                                        ? html`
                                              <span class="thread-count">
                                                  ${group.threads.length}
                                              </span>
                                          `
                                        : nothing}
                                    <span
                                        class=${classMap({
                                            chevron: true,
                                            collapsed: isCollapsed,
                                        })}
                                    >
                                        <${ViraIcon.assign({
                                            icon: chevronIcon,
                                        })}></${ViraIcon}>
                                    </span>
                                </button>
                                <span class="new-thread-wrapper">
                                    <button
                                        type="button"
                                        class="new-thread"
                                        aria-label=${`New thread in ${group.repo.name}`}
                                        title=${`New thread in ${group.repo.name}`}
                                        ${listen('click', () => {
                                            inputs.buildV2State.draftRepoPath.setValue(
                                                group.repo.path,
                                            );
                                            inputs.route.navigate([
                                                newThreadSubPath,
                                            ]);
                                        })}
                                    >
                                        <${ViraIcon.assign({
                                            icon: newThreadIcon,
                                        })}></${ViraIcon}>
                                    </button>
                                </span>
                            </li>
                            ${isCollapsed
                                ? nothing
                                : group.threads.map((thread) => {
                                      return html`
                                          <li>
                                              <${VirBuildV2ThreadRow.assign({
                                                  thread,
                                                  isActive: thread.id === activeThreadId,
                                              })}
                                                  ${listen(
                                                      VirBuildV2ThreadRow.events.selected,
                                                      () => {
                                                          selectThread(thread);
                                                      },
                                                  )}
                                                  ${listen(
                                                      VirBuildV2ThreadRow.events.renamed,
                                                      async (event) => {
                                                          await runAction(async () => {
                                                              const renamed =
                                                                  await buildV2Client.call(
                                                                      'renameThread',
                                                                      {
                                                                          threadId: thread.id,
                                                                          title: event.detail,
                                                                      },
                                                                  );
                                                              storeThread(
                                                                  inputs.buildV2State,
                                                                  renamed.thread,
                                                              );
                                                          });
                                                      },
                                                  )}
                                                  ${listen(
                                                      VirBuildV2ThreadRow.events.archived,
                                                      async () => {
                                                          await runAction(async () => {
                                                              await buildV2Client.call(
                                                                  'archiveThread',
                                                                  {
                                                                      threadId: thread.id,
                                                                  },
                                                              );
                                                              inputs.buildV2State.threads.setValue(
                                                                  inputs.buildV2State.threads.value?.filter(
                                                                      (existing) => {
                                                                          return (
                                                                              existing.id !==
                                                                              thread.id
                                                                          );
                                                                      },
                                                                  ),
                                                              );
                                                              if (thread.id === activeThreadId) {
                                                                  inputs.route.navigate([]);
                                                              }
                                                          });
                                                      },
                                                  )}
                                              ></${VirBuildV2ThreadRow}>
                                          </li>
                                      `;
                                  })}
                        `;
                    })}
                </ul>
            </div>
        `;
    },
});
