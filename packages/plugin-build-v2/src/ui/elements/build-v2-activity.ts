import {defineActivity} from '@agent-storm/core/frontend';
import {css, html, keyed, listen} from 'element-vir';
import {viraThemeByKeys} from 'vira';
import {ThreadStatus} from '../../build-v2-api.js';
import {buildV2Memory} from '../../util/build-v2-memory.js';
import {
    buildV2ActivityId,
    createBuildV2State,
    newThreadSubPath,
    startThreadSync,
    storeThread,
} from '../../util/build-v2-state.js';
import {VirAiChat} from './vir-ai-chat.element.js';
import {VirBuildV2Sidebar} from './vir-build-v2-sidebar.element.js';

/** Chat threads with Claude and Codex, listed by repo, one open at a time. */
export const buildV2Activity = defineActivity({
    id: buildV2ActivityId,
    label: 'Build V2',
    /** The plugin itself starts off, so its one activity shows as soon as the plugin is on. */
    isEnabledByDefault: true,
    createState: createBuildV2State,
    mobileMenuTitle: 'Threads',
    sidebar: {
        widthSetting: buildV2Memory.sidebarWidth,
        render({context, state, route}) {
            return html`
                <${VirBuildV2Sidebar.assign({
                    context,
                    route,
                    buildV2State: state,
                })}></${VirBuildV2Sidebar}>
            `;
        },
    },
    isKeptMounted: true,
    render({context, state, route}) {
        const [firstSubPath] = route.subPaths;
        const draftRepoPath = state.draftRepoPath.value;
        const threadId = firstSubPath === newThreadSubPath ? undefined : firstSubPath;

        if (!threadId && !(firstSubPath === newThreadSubPath && draftRepoPath)) {
            return html`
                <div
                    style=${css`
                        display: flex;
                        flex-direction: column;
                        align-items: center;
                        justify-content: center;
                        gap: 6px;
                        height: 100%;
                        padding: 16px;
                        box-sizing: border-box;
                        text-align: center;
                    `}
                >
                    <strong>Pick a thread to continue</strong>
                    <span
                        style=${css`
                            color: ${viraThemeByKeys.grey.foreground['non-body'].foreground.value};
                        `}
                    >
                        Select a thread, or start a new one from a project in the sidebar.
                    </span>
                </div>
            `;
        }

        const thread = state.threads.value?.find((existing) => existing.id === threadId);

        return keyed(
            threadId || `draft:${draftRepoPath}`,
            html`
                <${VirAiChat.assign({
                    context,
                    threadId,
                    repoPath: thread?.repoPath || draftRepoPath || '',
                })}
                    ${listen(VirAiChat.events.threadCreated, (event) => {
                        state.draftRepoPath.setValue(undefined);
                        storeThread(state, event.detail);
                        buildV2Memory.selectedThread.write(event.detail.id);
                        route.navigate([
                            event.detail.id,
                        ]);
                    })}
                ></${VirAiChat}>
            `,
        );
    },
    findTitle({state, subPaths}) {
        const [threadId] = subPaths;
        return state.threads.value?.find((thread) => thread.id === threadId)?.title;
    },
    findCount({state}) {
        return (
            state.threads.value?.filter((thread) => thread.status === ThreadStatus.NeedsApproval)
                .length || undefined
        );
    },
    findRestoredSubPaths({state}) {
        const rememberedId = buildV2Memory.selectedThread.read();
        return rememberedId && state.threads.value?.some((thread) => thread.id === rememberedId)
            ? [
                  rememberedId,
              ]
            : undefined;
    },
    findRedirect({subPaths, state}) {
        return subPaths.length > 1 ||
            (subPaths[0] === newThreadSubPath && !state.draftRepoPath.value)
            ? []
            : undefined;
    },
    startWithApp({state}) {
        return startThreadSync(state);
    },
});
