import {type Config, type FolderInfo} from '@agent-storm/common';
import {css, defineElementEvent, html, listen, nothing} from 'element-vir';
import {ViraDropdown, ViraInput} from 'vira';
import {type ValueUpdate} from '../../util/batched-writer.js';
import {defineAppElement} from '../define-app-element.js';
import {settingsCardCss, VirSettingsRow} from './vir-settings-row.element.js';

function toFolderLabel(folder: Readonly<FolderInfo>, folderInfo: ReadonlyMap<string, FolderInfo>) {
    const parentName = folder.parentRepoPath && folderInfo.get(folder.parentRepoPath)?.name;
    return parentName ? `${parentName} / ${folder.name}` : folder.name;
}

/**
 * The Settings modal's per-folder overrides. A worktree inherits its worktree root's AI, and shares
 * its repo's init command.
 */
export const VirSettingsFolders = defineAppElement<{
    config: Readonly<Config>;
    folderInfo: ReadonlyMap<string, FolderInfo>;
    /** The folder being edited. */
    folder: string | undefined;
}>()({
    tagName: 'vir-settings-folders',
    events: {
        configChange: defineElementEvent<ValueUpdate<Config>>(),
        folderSelect: defineElementEvent<string>(),
    },
    styles: css`
        ${settingsCardCss}

        :host {
            display: flex;
            flex-direction: column;
            gap: 16px;
        }
    `,
    render({inputs, dispatch, events}) {
        function changeConfig(update: ValueUpdate<Config>) {
            dispatch(
                new events.configChange({
                    detail: update,
                }),
            );
        }

        const folder = inputs.folder ? inputs.folderInfo.get(inputs.folder) : undefined;
        const folderOptions = [...inputs.folderInfo.values()]
            .map((info) => {
                return {
                    value: info.path,
                    label: toFolderLabel(info, inputs.folderInfo),
                };
            })
            .toSorted((first, second) => first.label.localeCompare(second.label));

        function renderFolderRows(selected: Readonly<FolderInfo>) {
            const config = inputs.config;
            const override = config.folderAiIds.find((entry) => entry.folder === selected.path);
            const parentOverrideId = selected.parentRepoPath
                ? config.folderAiIds.find((entry) => entry.folder === selected.parentRepoPath)?.aiId
                : undefined;
            const inherited =
                config.aiDefinitions.find((definition) => definition.id === parentOverrideId) ||
                config.aiDefinitions.find((definition) => definition.id === config.defaultAiId) ||
                config.aiDefinitions[0];
            const repo =
                config.repos.find((entry) => entry.path === selected.path) ||
                config.repos.find((entry) => entry.path === selected.parentRepoPath);
            const repoName =
                repo && repo.path !== selected.path
                    ? inputs.folderInfo.get(repo.path)?.name || repo.path
                    : undefined;

            function setAi(aiId: string) {
                changeConfig((current) => {
                    return {
                        ...current,
                        folderAiIds: [
                            ...current.folderAiIds.filter(
                                (entry) => entry.folder !== selected.path,
                            ),
                            ...(aiId
                                ? [
                                      {
                                          folder: selected.path,
                                          aiId,
                                      },
                                  ]
                                : []),
                        ],
                    };
                });
            }

            function setInitCommand(postWorktreeCmd: string | null) {
                changeConfig((current) => {
                    return {
                        ...current,
                        repos: current.repos.map((entry) => {
                            return entry.path === repo?.path
                                ? {
                                      ...entry,
                                      postWorktreeCmd,
                                  }
                                : entry;
                        }),
                    };
                });
            }

            return html`
                <span class="card-title">${toFolderLabel(selected, inputs.folderInfo)}</span>
                <div class="card">
                    <${VirSettingsRow.assign({
                        rowTitle: 'AI',
                        description: [
                            selected.isWorktreeRoot ? 'Its worktrees inherit this choice.' : '',
                            'A running AI pane keeps its AI until it restarts.',
                        ]
                            .filter(Boolean)
                            .join(' '),
                        isModified: !!override,
                    })}
                        ${listen(VirSettingsRow.events.reset, () => {
                            setAi('');
                        })}
                    >
                        <${ViraDropdown.assign({
                            options: [
                                {
                                    value: '',
                                    label: inherited ? `Inherit (${inherited.name})` : 'Inherit',
                                },
                                ...config.aiDefinitions.map((definition) => {
                                    return {
                                        value: definition.id,
                                        label: definition.name,
                                    };
                                }),
                            ],
                            selected: [
                                override?.aiId || '',
                            ],
                        })}
                            ${listen(ViraDropdown.events.selectedValuesChange, (event) => {
                                setAi(event.detail[0] || '');
                            })}
                        ></${ViraDropdown}>
                    </${VirSettingsRow}>
                    ${repo
                        ? html`
                              <${VirSettingsRow.assign({
                                  rowTitle: 'Init command',
                                  description: repoName
                                      ? `Runs in each new worktree of ${repoName}, so every one of its worktrees shares it.`
                                      : 'Runs in each new worktree of this repo.',
                                  isModified: repo.postWorktreeCmd != undefined,
                              })}
                                  ${listen(VirSettingsRow.events.reset, () => {
                                      setInitCommand(null);
                                  })}
                              >
                                  <${ViraInput.assign({
                                      value: repo.postWorktreeCmd ?? '',
                                      placeholder: config.postWorktreeCmd
                                          ? `Default: ${config.postWorktreeCmd}`
                                          : 'None',
                                      showClearButton: true,
                                      disableBrowserHelps: true,
                                  })}
                                      ${listen(ViraInput.events.valueChange, (event) => {
                                          /** Null falls back to the default command. */
                                          setInitCommand(event.detail || null);
                                      })}
                                  ></${ViraInput}>
                              </${VirSettingsRow}>
                          `
                        : nothing}
                </div>
            `;
        }

        return html`
            <div class="card">
                <${VirSettingsRow.assign({
                    rowTitle: 'Folder',
                    description: 'The folder whose settings to override.',
                })}>
                    <${ViraDropdown.assign({
                        options: folderOptions,
                        selected: folder
                            ? [
                                  folder.path,
                              ]
                            : [],
                        placeholder: 'Pick a folder...',
                        isSearchable: true,
                    })}
                        ${listen(ViraDropdown.events.selectedValuesChange, (event) => {
                            const path = event.detail[0];
                            if (path) {
                                dispatch(
                                    new events.folderSelect({
                                        detail: path,
                                    }),
                                );
                            }
                        })}
                    ></${ViraDropdown}>
                </${VirSettingsRow}>
            </div>
            ${folder ? renderFolderRows(folder) : nothing}
        `;
    },
});
