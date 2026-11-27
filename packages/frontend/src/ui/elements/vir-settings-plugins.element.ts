import {PluginDecision, PluginStatus, type PluginEntry} from '@agent-storm/common';
import {defineAppElement, settingsCardCss, type AppContext} from '@agent-storm/core/frontend';
import {extractErrorMessage} from '@augment-vir/common';
import {css, html, listen, nothing} from 'element-vir';
import {
    ViraButton,
    ViraColorVariant,
    ViraEmphasis,
    ViraSize,
    ViraTag,
    viraThemeByKeys,
    ViraThemeColorName,
} from 'vira';

const statusLabels: Readonly<Record<PluginStatus, string>> = {
    [PluginStatus.Active]: 'Running',
    [PluginStatus.NeedsApproval]: 'Needs approval',
    [PluginStatus.Disabled]: 'Off until you turn it on',
    [PluginStatus.Changed]: 'Changed since you approved it',
    [PluginStatus.Blocked]: 'Blocked',
    [PluginStatus.Invalid]: "Can't run",
    [PluginStatus.IncompatibleCore]: "Can't run on this version of Agent Storm",
    [PluginStatus.MissingDependency]: "Off, since a plugin it depends on isn't running",
};

/**
 * The Settings modal's Plugins section: every built-in plugin, which the user can turn on or off,
 * and every plugin in the plugins folder, which runs only once the user approves it.
 */

function isWaiting(plugin: Readonly<PluginEntry>) {
    return plugin.status === PluginStatus.NeedsApproval || plugin.status === PluginStatus.Changed;
}

export const VirSettingsPlugins = defineAppElement<{
    context: AppContext;
    /** Shows only this plugin. Undefined shows every plugin. */
    pluginId: string | undefined;
}>()({
    tagName: 'vir-settings-plugins',
    state() {
        return {
            error: '',
            /** The plugin whose decision is being saved, to disable its buttons meanwhile. */
            savingPluginId: '',
        };
    },
    styles: css`
        ${settingsCardCss}

        :host {
            display: flex;
            flex-direction: column;
            gap: 16px;
        }

        .plugin {
            display: flex;
            flex-direction: column;
            gap: 8px;
            padding: 12px 16px;
            min-width: 0;
        }

        .plugin-name {
            display: flex;
            align-items: center;
            gap: 8px;
            font-weight: 600;
        }

        .details {
            display: flex;
            flex-direction: column;
            gap: 4px;
            font-size: 12px;
            color: ${viraThemeByKeys.grey.foreground['non-body'].foreground.value};
            overflow-wrap: anywhere;
        }

        .warning {
            font-size: 12px;
            color: ${viraThemeByKeys.red.foreground['non-body'].foreground.value};
        }

        .buttons {
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
        }

        .mono {
            font-family: ui-monospace, monospace;
        }
    `,
    render({inputs, state, updateState}) {
        const plugins = inputs.context.plugins;
        const response = plugins.value.response;
        const decisions = response?.decisions || [];
        const builtInPlugins = (response?.plugins || []).filter((plugin) => plugin.isBuiltIn);
        const externalPlugins = (response?.plugins || []).filter((plugin) => !plugin.isBuiltIn);

        async function saveDecision(
            params: Readonly<{
                pluginId: string;
                decision: PluginDecision | undefined;
                contentHash: string;
            }>,
        ) {
            updateState({
                savingPluginId: params.pluginId,
                error: '',
            });
            try {
                await plugins.saveDecision(params);
                updateState({
                    savingPluginId: '',
                });
            } catch (error) {
                updateState({
                    savingPluginId: '',
                    error: extractErrorMessage(error),
                });
            }
        }

        function renderButton({
            text,
            pluginId,
            decision,
            contentHash,
            isDanger,
        }: Readonly<{
            text: string;
            pluginId: string;
            decision: PluginDecision | undefined;
            contentHash: string;
            isDanger: boolean;
        }>) {
            const isDisabled = !!state.savingPluginId;
            return html`
                <${ViraButton.assign({
                    text,
                    buttonSize: ViraSize.Small,
                    buttonEmphasis: ViraEmphasis.Subtle,
                    color: isDanger ? ViraColorVariant.Danger : ViraColorVariant.Neutral,
                    isDisabled,
                })}
                    ${listen('click', async () => {
                        if (isDisabled) {
                            return;
                        }
                        await saveDecision({
                            pluginId,
                            decision,
                            contentHash,
                        });
                    })}
                ></${ViraButton}>
            `;
        }

        function renderBuiltInButtons(plugin: Readonly<PluginEntry>) {
            const isOff =
                plugin.status === PluginStatus.Disabled || plugin.status === PluginStatus.Blocked;
            return renderButton({
                text: isOff ? 'Turn on' : 'Turn off',
                pluginId: plugin.id,
                decision: isOff ? PluginDecision.Approved : PluginDecision.Blocked,
                contentHash: '',
                isDanger: !isOff,
            });
        }

        function renderExternalButtons(plugin: Readonly<PluginEntry>) {
            const decision = decisions.find((entry) => entry.pluginId === plugin.id)?.decision;
            return html`
                ${isWaiting(plugin) && plugin.manifest
                    ? renderButton({
                          text: 'Approve',
                          pluginId: plugin.id,
                          decision: PluginDecision.Approved,
                          contentHash: plugin.contentHash,
                          isDanger: false,
                      })
                    : nothing}
                ${plugin.isSymlink &&
                plugin.manifest &&
                decision !== PluginDecision.TrustedWhileDeveloping
                    ? renderButton({
                          text: 'Trust while developing',
                          pluginId: plugin.id,
                          decision: PluginDecision.TrustedWhileDeveloping,
                          contentHash: plugin.contentHash,
                          isDanger: false,
                      })
                    : nothing}
                ${decision === PluginDecision.Blocked
                    ? nothing
                    : renderButton({
                          text: 'Block',
                          pluginId: plugin.id,
                          decision: PluginDecision.Blocked,
                          contentHash: '',
                          isDanger: true,
                      })}
                ${decision
                    ? renderButton({
                          text: decision === PluginDecision.Blocked ? 'Unblock' : 'Revoke',
                          pluginId: plugin.id,
                          decision: undefined,
                          contentHash: '',
                          isDanger: false,
                      })
                    : nothing}
            `;
        }

        function renderPlugin(plugin: Readonly<PluginEntry>) {
            const problem = plugin.problem || plugins.value.problems[plugin.id];
            const isOutdated = plugins.value.outdatedPluginIds.includes(plugin.id);
            return html`
                <div class="plugin">
                    <span class="plugin-name">
                        ${plugin.manifest?.name || plugin.folderName}
                        ${plugin.manifest?.isBeta
                            ? html`
                                  <${ViraTag.assign({
                                      text: 'Beta',
                                      color: ViraThemeColorName.yellow,
                                      size: ViraSize.Small,
                                      emphasis: ViraEmphasis.Subtle,
                                  })}></${ViraTag}>
                              `
                            : nothing}
                    </span>
                    <div class="details">
                        <span>${statusLabels[plugin.status]}</span>
                        ${plugin.manifest?.description
                            ? html`
                                  <span>${plugin.manifest.description}</span>
                              `
                            : nothing}
                        ${plugin.isBuiltIn
                            ? nothing
                            : html`
                                  <span class="mono">
                                      ${plugin.realPath}${plugin.isSymlink ? ' (symlinked)' : ''}
                                  </span>
                              `}
                        ${plugin.gitRemote && !plugin.isBuiltIn
                            ? html`
                                  <span class="mono">${plugin.gitRemote}</span>
                              `
                            : nothing}
                        ${plugin.contentHash && !plugin.isBuiltIn
                            ? html`
                                  <span class="mono">
                                      Version ${plugin.contentHash.slice(0, 12)}
                                  </span>
                              `
                            : nothing}
                        ${isOutdated
                            ? html`
                                  <span>Its new version runs once you reload this window.</span>
                              `
                            : nothing}
                    </div>
                    ${plugin.status === PluginStatus.IncompatibleCore && plugin.manifest
                        ? html`
                              <span class="warning">
                                  It works with core ${plugin.manifest.coreVersionRange}, and this
                                  app has core ${response?.coreVersion}.
                              </span>
                          `
                        : nothing}
                    ${problem
                        ? html`
                              <span class="warning">${problem}</span>
                          `
                        : nothing}
                    ${isWaiting(plugin)
                        ? html`
                              <span class="warning">
                                  Approving runs this plugin's code in the app with full access to
                                  your folders, terminals, and AIs. Only approve plugins you trust.
                              </span>
                          `
                        : nothing}
                    <div class="buttons">
                        ${plugin.isBuiltIn
                            ? renderBuiltInButtons(plugin)
                            : renderExternalButtons(plugin)}
                    </div>
                </div>
            `;
        }

        return html`
            ${state.error
                ? html`
                      <span class="warning">${state.error}</span>
                  `
                : nothing}
            ${inputs.pluginId ? renderOne(inputs.pluginId) : renderAll()}
        `;

        function renderOne(pluginId: string) {
            const plugin = response?.plugins.find((entry) => entry.id === pluginId);
            return html`
                <div class="card">${plugin ? renderPlugin(plugin) : nothing}</div>
            `;
        }

        function renderAll() {
            return html`
                <div class="card">
                    <div class="card-hint">
                        Built in. These run without approval. Turning one off removes what it adds.
                    </div>
                    ${builtInPlugins.map(renderPlugin)}
                </div>
                <div class="card">
                    <div class="card-hint">
                        From your plugins
                        folder${response
                            ? html`
                                  ,
                                  <span class="mono">${response.pluginsDir}</span>
                              `
                            : nothing}.
                        Each folder in it, or symlink to one, with an agent-storm-plugin.json is a
                        plugin. None of a plugin's code is loaded until you approve it.
                    </div>
                    ${externalPlugins.length
                        ? externalPlugins.map(renderPlugin)
                        : html`
                              <div class="card-hint">No plugins yet.</div>
                          `}
                </div>
            `;
        }
    },
});
