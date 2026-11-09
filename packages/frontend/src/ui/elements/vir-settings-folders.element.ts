import {folderSettingsEndpoint, type FolderInfo, type Settings} from '@agent-storm/common';
import {
    defineAppElement,
    fetchApi,
    settingsCardCss,
    VirSettingsRow,
    type ValueUpdate,
} from '@agent-storm/core/frontend';
import {check} from '@augment-vir/assert';
import {HttpMethod} from '@rest-vir/api';
import {asyncProp, css, defineElementEvent, html, listen, nothing} from 'element-vir';
import {ViraDropdown, ViraInput} from 'vira';

function toFolderLabel(folder: Readonly<FolderInfo>, folderInfo: ReadonlyMap<string, FolderInfo>) {
    const parentName = folder.parentRepoPath && folderInfo.get(folder.parentRepoPath)?.name;
    return parentName ? `${parentName} / ${folder.name}` : folder.name;
}

/**
 * The Settings modal's per-folder overrides. A worktree inherits its worktree root's AI, and shares
 * its repo's init command. Also lists the folder's own settings files, which apply beneath the
 * user's choices here and can't be edited from the app.
 */
export const VirSettingsFolders = defineAppElement<{
    settings: Readonly<Settings>;
    folderInfo: ReadonlyMap<string, FolderInfo>;
    /** The folder being edited. */
    folder: string | undefined;
}>()({
    tagName: 'vir-settings-folders',
    events: {
        settingsChange: defineElementEvent<ValueUpdate<Settings>>(),
        folderSelect: defineElementEvent<string>(),
    },
    state() {
        return {
            folderFiles: asyncProp({
                async updateCallback({folder}: Readonly<{folder: string}>) {
                    return (
                        await fetchApi(folderSettingsEndpoint, HttpMethod.Post, {
                            requestData: {
                                folder,
                            },
                        })
                    ).files;
                },
            }),
        };
    },
    styles: css`
        ${settingsCardCss}

        :host {
            display: flex;
            flex-direction: column;
            gap: 16px;
        }

        .settings-file {
            display: flex;
            flex-direction: column;
            gap: 8px;
            padding: 12px 16px;
            min-width: 0;

            & pre {
                margin: 0;
                overflow-x: auto;
                font-family: ui-monospace, monospace;
                font-size: 12px;
            }
        }

        .file-path {
            font-family: ui-monospace, monospace;
            font-size: 12px;
            overflow-wrap: anywhere;
        }
    `,
    render({inputs, state, dispatch, events}) {
        function changeSettings(update: ValueUpdate<Settings>) {
            dispatch(
                new events.settingsChange({
                    detail: update,
                }),
            );
        }

        const folder = inputs.folder ? inputs.folderInfo.get(inputs.folder) : undefined;
        if (folder) {
            state.folderFiles.update({
                folder: folder.path,
            });
        }
        const folderOptions = [...inputs.folderInfo.values()]
            .map((info) => {
                return {
                    value: info.path,
                    label: toFolderLabel(info, inputs.folderInfo),
                };
            })
            .toSorted((first, second) => first.label.localeCompare(second.label));

        function renderSettingsFiles() {
            const files = state.folderFiles.value;
            if (!check.isArray(files)) {
                return files instanceof Error
                    ? html`
                          <div class="card-hint">${files.message}</div>
                      `
                    : nothing;
            }
            return files.length
                ? files.map((file) => {
                      return html`
                          <div class="settings-file">
                              <span class="file-path">${file.path}</span>
                              ${file.problem
                                  ? html`
                                        <span class="card-hint">${file.problem}</span>
                                    `
                                  : html`
                                        <pre>${file.contents}</pre>
                                    `}
                          </div>
                      `;
                  })
                : html`
                      <div class="card-hint">
                          No settings files. A repo can set its defaults in
                          .agent-storm/settings.json (or .yaml or .toml) in any folder from this one
                          up to your home folder.
                      </div>
                  `;
        }

        function renderFolderRows(selected: Readonly<FolderInfo>) {
            const settings = inputs.settings;
            const override = settings.folderAiIds.find((entry) => entry.folder === selected.path);
            const aiDefinitions = [
                ...settings.aiDefinitions,
                ...selected.folderAiDefinitions,
            ];
            const inherited = aiDefinitions.find(
                (definition) => definition.id === selected.inheritedAiId,
            );
            const repoPath = selected.parentRepoPath || selected.path;
            const repoName =
                repoPath === selected.path
                    ? undefined
                    : inputs.folderInfo.get(repoPath)?.name || repoPath;
            const initCommand =
                settings.folderPostWorktreeCmds.find((entry) => entry.folder === repoPath)
                    ?.postWorktreeCmd || '';

            function setAi(aiId: string) {
                changeSettings((current) => {
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

            /** An empty command falls back to the folder's settings files, then the default. */
            function setInitCommand(postWorktreeCmd: string) {
                changeSettings((current) => {
                    return {
                        ...current,
                        folderPostWorktreeCmds: [
                            ...current.folderPostWorktreeCmds.filter(
                                (entry) => entry.folder !== repoPath,
                            ),
                            ...(postWorktreeCmd
                                ? [
                                      {
                                          folder: repoPath,
                                          postWorktreeCmd,
                                      },
                                  ]
                                : []),
                        ],
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
                                ...aiDefinitions.map((definition) => {
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
                    <${VirSettingsRow.assign({
                        rowTitle: 'Init command',
                        description: repoName
                            ? `Runs in each new worktree of ${repoName}, so every one of its worktrees shares it.`
                            : 'Runs in each new worktree of this repo.',
                        isModified: !!initCommand,
                    })}
                        ${listen(VirSettingsRow.events.reset, () => {
                            setInitCommand('');
                        })}
                    >
                        <${ViraInput.assign({
                            value: initCommand,
                            placeholder: settings.postWorktreeCmd
                                ? `Default: ${settings.postWorktreeCmd}`
                                : 'None',
                            showClearButton: true,
                            disableBrowserHelps: true,
                        })}
                            ${listen(ViraInput.events.valueChange, (event) => {
                                setInitCommand(event.detail);
                            })}
                        ></${ViraInput}>
                    </${VirSettingsRow}>
                </div>
                <span class="card-title">Settings files</span>
                <div class="card">${renderSettingsFiles()}</div>
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
