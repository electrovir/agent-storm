import {
    isNotificationEnabled,
    isNotificationOnByDefault,
    NotificationDelivery,
    type FolderInfo,
    type NotificationType,
    type Settings,
} from '@agent-storm/common';
import {
    defineAppElement,
    settingsCardCss,
    VirSettingsRow,
    type PluginDefinition,
    type ValueUpdate,
} from '@agent-storm/core/frontend';
import {check} from '@augment-vir/assert';
import {extractErrorMessage, getEnumValues} from '@augment-vir/common';
import {css, defineElementEvent, html, listen, nothing, unsafeCSS} from 'element-vir';
import {
    tooltip,
    ViraButton,
    ViraCheckbox,
    ViraColorVariant,
    ViraDropdown,
    ViraEmphasis,
    ViraSize,
    viraThemeByKeys,
} from 'vira';
import {
    disablePush,
    enablePush,
    PushStatus,
    readPushStatus,
    sendTestPush,
} from '../../util/push-notifications.js';

const deliveryHeaders: Readonly<
    Record<
        NotificationDelivery,
        {
            label: string;
            description: string;
        }
    >
> = {
    [NotificationDelivery.InApp]: {
        label: 'In-app',
        description: 'A toast in each open window.',
    },
    [NotificationDelivery.Persistent]: {
        label: 'Persistent',
        description:
            'Stays until dismissed. Otherwise a toast hides on its own after a few seconds.',
    },
    [NotificationDelivery.Push]: {
        label: 'Push',
        description: 'A system notification on each device that turned them on.',
    },
};

const pushStatusLabels: Readonly<Record<PushStatus, string>> = {
    [PushStatus.Insecure]:
        'Browsers only allow push notifications over https. Set an HTTPS certificate in General.',
    [PushStatus.Unsupported]:
        "This browser can't receive push notifications. On an iPhone or iPad, add Agent Storm to the Home Screen and open it from there.",
    [PushStatus.Denied]:
        'Notifications are blocked for this site. Allow them in the browser or system settings.',
    [PushStatus.Off]: 'Off on this device.',
    [PushStatus.On]: 'On for this device.',
};

/** A folder cell's choice: its own on or off, or whatever applies without it. */
enum FolderChoice {
    Inherit = 'inherit',
    On = 'on',
    Off = 'off',
}

function isSameChoice(
    entry: Readonly<{typeId: string; delivery: NotificationDelivery}>,
    type: Readonly<NotificationType>,
    delivery: NotificationDelivery,
) {
    return entry.typeId === type.id && entry.delivery === delivery;
}

/**
 * The Settings modal's Notifications section: which notification types each delivery shows, for
 * every folder or for one, whether each stays until dismissed, and whether this device gets push
 * notifications.
 */
export const VirSettingsNotifications = defineAppElement<{
    settings: Readonly<Settings>;
    folderInfo: ReadonlyMap<string, FolderInfo>;
    notificationTypes: ReadonlyArray<NotificationType>;
    plugins: ReadonlyArray<Readonly<Pick<PluginDefinition, 'id' | 'name'>>>;
}>()({
    tagName: 'vir-settings-notifications',
    events: {
        settingsChange: defineElementEvent<ValueUpdate<Settings>>(),
    },
    state() {
        return {
            /** The folder whose overrides the table edits, or empty for every folder's choices. */
            folder: '',
            pushStatus: undefined as PushStatus | undefined,
            isPushBusy: false,
            pushMessage: '',
        };
    },
    styles: css`
        ${settingsCardCss}

        :host,
        .choices {
            display: flex;
            flex-direction: column;
            gap: 16px;
        }

        .choices[inert] {
            opacity: 0.5;
        }

        .push-buttons {
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
        }

        .table {
            display: grid;
            grid-template-columns: 1fr repeat(
                    ${unsafeCSS(getEnumValues(NotificationDelivery).length)},
                    auto
                );
            align-items: center;
            column-gap: 16px;
            row-gap: 12px;
            padding: 12px 16px;
            position: relative;
        }

        .push-divider {
            /**
             * Absolutely positioned so grid auto-placement skips it, and its unset rows span the
             * whole table.
             */
            position: absolute;
            grid-column: ${unsafeCSS(
                getEnumValues(NotificationDelivery).indexOf(NotificationDelivery.Push) + 2,
            )};
            top: 12px;
            bottom: 12px;
            left: -8px;
            border-left: 1px solid ${viraThemeByKeys.grey['behind-bg'].decoration.background.value};
        }

        .column-header {
            font-size: 12px;
            font-weight: 600;
            text-align: center;
            color: ${viraThemeByKeys.grey.foreground['non-body'].foreground.value};
        }

        .divider {
            grid-column: 1 / -1;
            border-top: 1px solid ${viraThemeByKeys.grey['behind-bg'].decoration.background.value};
        }

        .type {
            display: flex;
            flex-direction: column;
            gap: 2px;
            min-width: 0;
        }

        .type-description {
            font-size: 12px;
            color: ${viraThemeByKeys.grey.foreground['non-body'].foreground.value};
        }

        .cell {
            display: flex;
            justify-content: center;

            & ${ViraDropdown} {
                width: 130px;
            }
        }
    `,
    init({updateState}) {
        void readPushStatus().then((pushStatus) => {
            updateState({
                pushStatus,
            });
        });
    },
    render({inputs, state, dispatch, events, updateState}) {
        function changeSettings(update: ValueUpdate<Settings>) {
            dispatch(
                new events.settingsChange({
                    detail: update,
                }),
            );
        }

        async function runPushAction(
            action: () => Promise<
                | {
                      pushStatus: PushStatus;
                  }
                | {
                      pushMessage: string;
                  }
            >,
        ) {
            if (state.isPushBusy) {
                return;
            }
            updateState({
                isPushBusy: true,
                pushMessage: '',
            });
            try {
                updateState(await action());
            } catch (error) {
                updateState({
                    pushMessage: extractErrorMessage(error),
                });
            } finally {
                updateState({
                    isPushBusy: false,
                });
            }
        }

        const selectedFolder = inputs.folderInfo.get(state.folder);
        const folderEntries = (inputs.settings.folderNotifications || []).filter((entry) => {
            return entry.folder === state.folder;
        });
        const folderOptions = [
            {
                value: '',
                label: 'All folders',
            },
            ...[...inputs.folderInfo.values()]
                .filter((info) => !info.parentRepoPath)
                .map((info) => {
                    return {
                        value: info.path,
                        label: info.name,
                    };
                })
                .toSorted((first, second) => first.label.localeCompare(second.label)),
        ];

        function setGlobalChoice({
            types,
            delivery,
            isEnabled,
        }: Readonly<{
            types: ReadonlyArray<Readonly<NotificationType>>;
            delivery: NotificationDelivery;
            isEnabled: boolean;
        }>) {
            changeSettings((current) => {
                return {
                    ...current,
                    notifications: [
                        ...(current.notifications || []).filter((entry) => {
                            return !types.some((type) => isSameChoice(entry, type, delivery));
                        }),
                        ...types
                            .filter((type) => {
                                return (
                                    isEnabled !==
                                    isNotificationOnByDefault({
                                        type,
                                        delivery,
                                    })
                                );
                            })
                            .map((type) => {
                                return {
                                    typeId: type.id,
                                    delivery,
                                    isEnabled,
                                };
                            }),
                    ],
                };
            });
        }

        function setFolderChoice({
            types,
            delivery,
            choice,
        }: Readonly<{
            types: ReadonlyArray<Readonly<NotificationType>>;
            delivery: NotificationDelivery;
            choice: FolderChoice;
        }>) {
            const folder = state.folder;
            changeSettings((current) => {
                return {
                    ...current,
                    folderNotifications: [
                        ...(current.folderNotifications || []).filter((entry) => {
                            return (
                                entry.folder !== folder ||
                                !types.some((type) => isSameChoice(entry, type, delivery))
                            );
                        }),
                        ...(choice === FolderChoice.Inherit
                            ? []
                            : types.map((type) => {
                                  return {
                                      folder,
                                      typeId: type.id,
                                      delivery,
                                      isEnabled: choice === FolderChoice.On,
                                  };
                              })),
                    ],
                };
            });
        }

        function isGloballyEnabled(
            type: Readonly<NotificationType>,
            delivery: NotificationDelivery,
        ) {
            return isNotificationEnabled({
                settings: inputs.settings,
                type,
                delivery,
                folders: [],
            });
        }

        function readFolderChoice(
            type: Readonly<NotificationType>,
            delivery: NotificationDelivery,
        ) {
            const entry = folderEntries.find((each) => isSameChoice(each, type, delivery));
            return entry
                ? entry.isEnabled
                    ? FolderChoice.On
                    : FolderChoice.Off
                : FolderChoice.Inherit;
        }

        function renderFolderDropdown({
            types,
            delivery,
            inheritLabel,
        }: Readonly<{
            types: ReadonlyArray<Readonly<NotificationType>>;
            delivery: NotificationDelivery;
            inheritLabel: string;
        }>) {
            const choices = new Set(types.map((type) => readFolderChoice(type, delivery)));
            return html`
                <${ViraDropdown.assign({
                    options: [
                        {
                            value: FolderChoice.Inherit,
                            label: inheritLabel,
                        },
                        {
                            value: FolderChoice.On,
                            label: 'On',
                        },
                        {
                            value: FolderChoice.Off,
                            label: 'Off',
                        },
                    ],
                    selected: choices.size === 1 ? [...choices] : [],
                    placeholder: 'Mixed',
                })}
                    ${listen(ViraDropdown.events.selectedValuesChange, (event) => {
                        const selected = event.detail[0];
                        if (check.isEnumValue(selected, FolderChoice)) {
                            setFolderChoice({
                                types,
                                delivery,
                                choice: selected,
                            });
                        }
                    })}
                ></${ViraDropdown}>
            `;
        }

        /** The top row's cell, which shows whether every type agrees and sets all of them. */
        function renderAllCell(delivery: NotificationDelivery) {
            if (selectedFolder) {
                return renderFolderDropdown({
                    types: inputs.notificationTypes,
                    delivery,
                    inheritLabel: 'Inherit',
                });
            }
            const enabledCount = inputs.notificationTypes.filter((type) => {
                return isGloballyEnabled(type, delivery);
            }).length;
            return html`
                <${ViraCheckbox.assign({
                    fillWhenChecked: true,
                    value: enabledCount === inputs.notificationTypes.length,
                    isIndeterminate:
                        !!enabledCount && enabledCount < inputs.notificationTypes.length,
                })}
                    ${listen(ViraCheckbox.events.valueChange, (event) => {
                        setGlobalChoice({
                            types: inputs.notificationTypes,
                            delivery,
                            isEnabled: event.detail,
                        });
                    })}
                ></${ViraCheckbox}>
            `;
        }

        function renderCell(type: Readonly<NotificationType>, delivery: NotificationDelivery) {
            if (selectedFolder) {
                return renderFolderDropdown({
                    types: [
                        type,
                    ],
                    delivery,
                    inheritLabel: isGloballyEnabled(type, delivery)
                        ? 'Inherit (on)'
                        : 'Inherit (off)',
                });
            }
            return html`
                <${ViraCheckbox.assign({
                    fillWhenChecked: true,
                    value: isGloballyEnabled(type, delivery),
                })}
                    ${listen(ViraCheckbox.events.valueChange, (event) => {
                        setGlobalChoice({
                            types: [
                                type,
                            ],
                            delivery,
                            isEnabled: event.detail,
                        });
                    })}
                ></${ViraCheckbox}>
            `;
        }

        const pushStatus = state.pushStatus;
        const canTogglePush = pushStatus === PushStatus.On || pushStatus === PushStatus.Off;

        return html`
            <div class="card">
                <${VirSettingsRow.assign({
                    rowTitle: 'Notifications',
                    description:
                        'Turn off to stop every notification, in-app and push, in every folder.',
                })}>
                    <${ViraCheckbox.assign({
                        fillWhenChecked: true,
                        value: !inputs.settings.muteNotifications,
                    })}
                        ${listen(ViraCheckbox.events.valueChange, (event) => {
                            changeSettings((current) => {
                                return {
                                    ...current,
                                    muteNotifications: !event.detail,
                                };
                            });
                        })}
                    ></${ViraCheckbox}>
                </${VirSettingsRow}>
            </div>
            <div class="choices" ?inert=${!!inputs.settings.muteNotifications}>
                <div class="card">
                    <${VirSettingsRow.assign({
                        rowTitle: 'Push notifications',
                        description: [
                            pushStatus ? pushStatusLabels[pushStatus] : '',
                            state.pushMessage,
                        ]
                            .filter(Boolean)
                            .join(' '),
                    })}>
                        <div class="push-buttons">
                            ${pushStatus === PushStatus.On
                                ? html`
                                      <${ViraButton.assign({
                                          text: 'Send test',
                                          buttonSize: ViraSize.Small,
                                          buttonEmphasis: ViraEmphasis.Subtle,
                                          color: ViraColorVariant.Neutral,
                                          isDisabled: state.isPushBusy,
                                      })}
                                          ${listen('click', async () => {
                                              await runPushAction(async () => {
                                                  return {
                                                      pushMessage:
                                                          (await sendTestPush()) ||
                                                          'Sent. It should show on this device.',
                                                  };
                                              });
                                          })}
                                      ></${ViraButton}>
                                  `
                                : nothing}
                            ${canTogglePush
                                ? html`
                                      <${ViraButton.assign({
                                          text:
                                              pushStatus === PushStatus.On ? 'Turn off' : 'Turn on',
                                          buttonSize: ViraSize.Small,
                                          isDisabled: state.isPushBusy,
                                      })}
                                          ${listen('click', async () => {
                                              await runPushAction(async () => {
                                                  return {
                                                      pushStatus:
                                                          pushStatus === PushStatus.On
                                                              ? await disablePush()
                                                              : await enablePush(),
                                                  };
                                              });
                                          })}
                                      ></${ViraButton}>
                                  `
                                : nothing}
                        </div>
                    </${VirSettingsRow}>
                </div>
                <div class="card">
                    <${VirSettingsRow.assign({
                        rowTitle: 'Folder',
                        description: selectedFolder
                            ? selectedFolder.parentRepoPath
                                ? "Overrides for this worktree. Anything left to inherit follows its repo's choices."
                                : "Overrides for this folder, which its worktrees inherit. Anything left to inherit follows every folder's choices."
                            : 'Choices for every folder. Pick a folder to override them there.',
                        isModified: !!folderEntries.length,
                    })}
                        ${listen(VirSettingsRow.events.reset, () => {
                            const folder = state.folder;
                            changeSettings((current) => {
                                return {
                                    ...current,
                                    folderNotifications: (current.folderNotifications || []).filter(
                                        (entry) => entry.folder !== folder,
                                    ),
                                };
                            });
                        })}
                    >
                        <${ViraDropdown.assign({
                            options: folderOptions,
                            selected: [
                                selectedFolder ? state.folder : '',
                            ],
                            isSearchable: true,
                        })}
                            ${listen(ViraDropdown.events.selectedValuesChange, (event) => {
                                updateState({
                                    folder: event.detail[0] || '',
                                });
                            })}
                        ></${ViraDropdown}>
                    </${VirSettingsRow}>
                </div>
                <div class="card">
                    ${inputs.notificationTypes.length
                        ? html`
                              <div class="table">
                                  <div class="push-divider"></div>
                                  <span></span>
                                  ${getEnumValues(NotificationDelivery).map((delivery) => {
                                      return html`
                                          <span
                                              class="column-header"
                                              ${tooltip(deliveryHeaders[delivery].description)}
                                          >
                                              ${deliveryHeaders[delivery].label}
                                          </span>
                                      `;
                                  })}
                                  <div class="type">
                                      <span>All notifications</span>
                                      <span class="type-description">
                                          Sets every row below at once.
                                      </span>
                                  </div>
                                  ${getEnumValues(NotificationDelivery).map((delivery) => {
                                      return html`
                                          <div class="cell">${renderAllCell(delivery)}</div>
                                      `;
                                  })}
                                  <div class="divider"></div>
                                  ${inputs.notificationTypes.map((type) => {
                                      const pluginName = inputs.plugins.find(
                                          (plugin) => plugin.id === type.pluginId,
                                      )?.name;
                                      return html`
                                          <div class="type">
                                              <span>${type.label}</span>
                                              <span class="type-description">
                                                  ${[
                                                      pluginName,
                                                      type.description,
                                                  ]
                                                      .filter(Boolean)
                                                      .join(' · ')}
                                              </span>
                                          </div>
                                          ${getEnumValues(NotificationDelivery).map((delivery) => {
                                              return html`
                                                  <div class="cell">
                                                      ${renderCell(type, delivery)}
                                                  </div>
                                              `;
                                          })}
                                      `;
                                  })}
                              </div>
                          `
                        : html`
                              <div class="card-hint">No running plugin sends notifications.</div>
                          `}
                </div>
            </div>
        `;
    },
});
