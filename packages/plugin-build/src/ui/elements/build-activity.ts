import {defineActivity, localStorageClient, type AppContext} from '@agent-storm/core/frontend';
import {html} from 'element-vir';
import {buildMemory} from '../../util/build-memory.js';
import {
    followFolderActivations,
    resolveBuildFolder,
    subPathsForFolder,
} from '../../util/build-route.js';
import {VirBuildSidebar} from './vir-build-sidebar.element.js';
import {VirBuildStage} from './vir-build-stage.element.js';

const buildLabel = 'Build';

function findActiveFolder(context: AppContext, subPaths: ReadonlyArray<string>) {
    return resolveBuildFolder(subPaths, context.folderData.value.folderInfo).folder;
}

/** Each repo and worktree's panes, picked from a list of folders. */
export const buildActivity = defineActivity({
    id: 'build',
    label: buildLabel,
    isEnabledByDefault: true,
    mobileMenuTitle: 'Repos',
    sidebar: {
        widthSetting: localStorageClient.sidebarWidth,
        render({context, route}) {
            return html`
                <${VirBuildSidebar.assign({
                    context,
                    route,
                    activeFolder: findActiveFolder(context, route.subPaths)?.path,
                })}></${VirBuildSidebar}>
            `;
        },
    },
    isKeptMounted: true,
    render({context, route}) {
        return html`
            <${VirBuildStage.assign({
                activeFolder: findActiveFolder(context, route.subPaths)?.path,
                context,
            })}></${VirBuildStage}>
        `;
    },
    findRestoredSubPaths({context}) {
        const folderInfo = context.folderData.value.folderInfo;
        const folder = folderInfo.get(buildMemory.selectedFolder.read() || '');
        return folder && subPathsForFolder(folder, folderInfo);
    },
    findRedirect({context, subPaths}) {
        return subPaths.length > 2 ||
            resolveBuildFolder(subPaths, context.folderData.value.folderInfo).isInvalid
            ? []
            : undefined;
    },
    findTitle({context, subPaths}) {
        return findActiveFolder(context, subPaths)?.name;
    },
    renderInDashboard({context, route}) {
        return context.folderData.value.folderInfo.size
            ? [
                  html`
                      <${VirBuildSidebar.assign({
                          context,
                          route,
                          activeFolder: undefined,
                          heading: buildLabel,
                      })}></${VirBuildSidebar}>
                  `,
              ]
            : [];
    },
    startWithApp({services, navigate}) {
        return followFolderActivations({
            folderData: services.folderData,
            navigate,
        });
    },
});
