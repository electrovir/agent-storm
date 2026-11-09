// cspell:words forgejo, gitea

import {
    checkPathEndpoint,
    claudeHooksInstallEndpoint,
    defaultSettings,
    ForgeType,
    onboardingEndpoint,
    restartDaemonEndpoint,
    settingsEndpoint,
    settingsJsonSchema,
    startAtLoginEndpoint,
    type OnboardingStatus,
    type Settings,
} from '@agent-storm/common';
import {
    defineAppElement,
    fetchApi,
    isActivityEnabled,
    localStorageClient,
    ScreenSize,
    scrollbackLimit,
    settingsCardCss,
    SettingsSection,
    staticTabRouter,
    toStaticTabRoute,
    VirSettingsRow,
    type AppContext,
    type SettingsTarget,
    type ValueUpdate,
} from '@agent-storm/core/frontend';
import {assertWrap, check} from '@augment-vir/assert';
import {
    extractErrorMessage,
    getEnumValues,
    getObjectTypedEntries,
    pickObjectKeys,
    typedObjectFromEntries,
    type JsonValue,
} from '@augment-vir/common';
import {extractEventTarget} from '@augment-vir/web';
import {HttpMethod} from '@rest-vir/api';
import {
    css,
    html,
    listen,
    nothing,
    onDomCreated,
    type HtmlInterpolation,
    type Observable,
} from 'element-vir';
import {
    LucideSearchIcon,
    ViraButton,
    ViraCheckbox,
    ViraColorVariant,
    ViraEmphasis,
    ViraInput,
    ViraInputType,
    ViraModal,
    ViraSize,
    ViraTabs,
    ViraTabsBarDirection,
    viraThemeByKeys,
    ViraThemeColorName,
    ViraThemeSwitcher,
} from 'vira';
import {createBatchedWriter} from '../../util/batched-writer.js';
import {
    findSettingsSection,
    listSettingsSections,
    type SettingsSectionPage,
} from '../../util/settings-sections.js';
import {VirSettingsAi} from './vir-settings-ai.element.js';
import {VirSettingsFolders} from './vir-settings-folders.element.js';
import {VirSettingsSchemaRow, type SettingSchema} from './vir-settings-schema-row.element.js';

/** Each forge with settings to show. A forge with none gets no card. */
const forgeCards = getEnumValues(ForgeType)
    .map((forgeType) => {
        const forgeSchema = settingsJsonSchema.properties.forges.properties[forgeType];
        return {
            forgeType,
            title: forgeSchema.title,
            properties: getObjectTypedEntries(
                forgeSchema.properties satisfies object as Readonly<
                    Record<string, SettingSchema & Readonly<{default: unknown}>>
                >,
            ),
        };
    })
    .filter((card) => card.properties.length);

function readForgeSetting(settings: Readonly<Settings>, forgeType: ForgeType, key: string) {
    return (settings.forges[forgeType] satisfies object as Readonly<Record<string, unknown>>)[key];
}

function setForgeSettings(
    settings: Readonly<Settings>,
    forgeType: ForgeType,
    forgeSettings: Readonly<Record<string, unknown>>,
): Settings {
    return {
        ...settings,
        forges: {
            ...settings.forges,
            [forgeType]: {
                ...settings.forges[forgeType],
                ...forgeSettings,
            },
        } satisfies Record<ForgeType, object> as Settings['forges'],
    };
}

/** One row of settings that search can show outside its section. */
type SettingsEntry = Readonly<{
    /** The id of the section the row belongs to. */
    section: string;
    /** Consecutive entries with the same title share a card, titled when this is set. */
    cardTitle: string | undefined;
    /** The row's title and description, which search matches. */
    searchText: ReadonlyArray<string | undefined>;
    template: HtmlInterpolation;
}>;

function isDefault({value, defaultValue}: Readonly<{value: unknown; defaultValue: unknown}>) {
    return check.jsonEquals((value ?? null) as JsonValue, (defaultValue ?? null) as JsonValue);
}

type SectionDefaults = Readonly<{
    isModified: (settings: Readonly<Settings>) => boolean;
    restore: ValueUpdate<Settings>;
}>;

/** Puts a section's schema settings back to their defaults. Undefined for a section with none. */
function createSchemaDefaults({
    schemaKeys,
}: Readonly<Pick<SettingsSectionPage, 'schemaKeys'>>): SectionDefaults | undefined {
    return schemaKeys.length
        ? {
              isModified(settings) {
                  return schemaKeys.some((key) => {
                      return !isDefault({
                          value: settings[key],
                          defaultValue: defaultSettings[key],
                      });
                  });
              },
              restore(settings) {
                  return {
                      ...settings,
                      ...pickObjectKeys(defaultSettings, schemaKeys),
                  };
              },
          }
        : undefined;
}

/** Sections whose settings don't all come from their schema keys. */
const customSectionDefaults: Readonly<Record<string, SectionDefaults | undefined>> = {
    [SettingsSection.Forges]: {
        isModified(settings) {
            return forgeCards.some((card) => {
                return card.properties.some(
                    ([
                        key,
                        schema,
                    ]) => {
                        return !isDefault({
                            value: readForgeSetting(settings, card.forgeType, key),
                            defaultValue: schema.default,
                        });
                    },
                );
            });
        },
        restore(settings) {
            return forgeCards.reduce((current, card) => {
                return setForgeSettings(
                    current,
                    card.forgeType,
                    typedObjectFromEntries(
                        card.properties.map(
                            ([
                                key,
                                schema,
                            ]) => {
                                return [
                                    key,
                                    schema.default,
                                ];
                            },
                        ),
                    ),
                );
            }, settings);
        },
    },
};

/**
 * The Settings modal: a searchable nav of sections beside the open section's settings. Every change
 * applies at once: it shows here right away and is written to the server shortly after, or when the
 * modal closes.
 */
export const VirSettingsModal = defineAppElement<{
    context: AppContext;
    /** Where the Settings modal is, or was last left in this window. */
    settingsTarget: Observable<SettingsTarget>;
    isSettingsOpen: Observable<boolean>;
}>()({
    tagName: 'vir-settings-modal',
    state() {
        return {
            settings: undefined as Settings | undefined,
            writers: undefined as
                | Readonly<{
                      settings: ReturnType<typeof createBatchedWriter<Settings>>;
                  }>
                | undefined,
            search: '',
            /** Undefined until the modal first closes. Reopening at the same target resumes it. */
            closedTarget: undefined as SettingsTarget | undefined,
            wasOpen: false,
            contentElement: undefined as HTMLElement | undefined,
            /** Captured while scrolling, since a closed `dialog` resets its contents' scroll. */
            contentScrollTop: 0,
            loadError: '',
            saveError: '',
            tlsCertPathError: '',
            scrollbackLimit: localStorageClient.scrollbackLimit.read(),
            /** The scrollback input's text, which may be out of bounds while the user types. */
            scrollbackDraft: undefined as string | undefined,
            isRestartingDaemon: false,
            daemonRestartError: '',
            /** Undefined until loaded, and when it fails to load, which hides the rows it drives. */
            onboardingStatus: undefined as OnboardingStatus | undefined,
            startAtLoginError: '',
            claudeHooksError: '',
            isInstallingClaudeHooks: false,
        };
    },
    styles: css`
        ${settingsCardCss}

        .body {
            display: flex;
            gap: 24px;
            width: min(960px, calc(100dvw - 48px));
            height: min(640px, calc(100dvh - 140px));
        }

        .body.mobile {
            flex-direction: column;
            gap: 12px;
            width: 100%;
            height: auto;
        }

        .nav {
            display: flex;
            flex-direction: column;
            flex-shrink: 0;
            gap: 12px;
            width: 200px;
            overflow-y: auto;

            & ${ViraInput} {
                width: 100%;
            }
        }

        .mobile .nav {
            width: 100%;
        }

        .content {
            display: flex;
            flex-direction: column;
            flex-grow: 1;
            gap: 16px;
            min-width: 0;
            overflow-y: auto;
        }

        .header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 8px;
            min-height: 32px;

            & h2 {
                margin: 0;
                font-size: 18px;
            }
        }

        .error {
            padding: 8px 12px;
            border: 1px solid currentColor;
            border-radius: 6px;
            color: ${viraThemeByKeys.red.foreground.body.foreground.value};
            background: ${viraThemeByKeys.red['behind-bg'].body.background.value};
            white-space: pre-wrap;
        }

        .result-section {
            display: flex;
            flex-direction: column;
            gap: 8px;
        }

        .result-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 8px;

            & h3 {
                margin: 0;
                font-size: 14px;
            }
        }

        .muted {
            color: ${viraThemeByKeys.grey.foreground['non-body'].foreground.value};
        }
    `,
    render({inputs, state, updateState, host}) {
        const target = inputs.settingsTarget.value;
        const sections = listSettingsSections(inputs.context.settingsSections);
        const isOpen = inputs.isSettingsOpen.value;
        if (isOpen !== state.wasOpen) {
            updateState({
                wasOpen: isOpen,
            });
            if (isOpen) {
                void load();
                if (target === state.closedTarget) {
                    requestAnimationFrame(() => {
                        if (host.instanceState.contentElement) {
                            host.instanceState.contentElement.scrollTop =
                                host.instanceState.contentScrollTop;
                        }
                    });
                } else {
                    updateState({
                        search: '',
                    });
                }
            }
        }

        function createWriters() {
            return {
                settings: createBatchedWriter<Settings>({
                    delay: {
                        milliseconds: 400,
                    },
                    read() {
                        return fetchApi(settingsEndpoint, HttpMethod.Get);
                    },
                    write(requestData) {
                        return fetchApi(settingsEndpoint, HttpMethod.Put, {
                            requestData,
                        });
                    },
                    async onSaved({previous, saved, pending}) {
                        updateState({
                            settings: pending.reduce(
                                (value: Settings, update) => update(value),
                                saved,
                            ),
                            saveError: '',
                        });
                        if (previous.useWebgl !== saved.useWebgl) {
                            /** Existing terminals only read `useWebgl` when they're created. */
                            window.location.reload();
                            return;
                        }
                        if (
                            !isDefault({
                                value: previous.aiDefinitions,
                                defaultValue: saved.aiDefinitions,
                            })
                        ) {
                            await inputs.context.paneRestarts.bumpAiConfig();
                        }
                        if (previous.tlsCertPath !== saved.tlsCertPath) {
                            /**
                             * Checked after the write: the certificate lives on the server's
                             * filesystem, so only the backend can stat it.
                             */
                            const checked = saved.tlsCertPath
                                ? await fetchApi(checkPathEndpoint, HttpMethod.Post, {
                                      requestData: {
                                          path: saved.tlsCertPath,
                                      },
                                  })
                                : undefined;
                            updateState({
                                tlsCertPathError:
                                    checked && !checked.exists
                                        ? `No file found at ${checked.resolvedPath}`
                                        : '',
                            });
                        }
                        await inputs.context.folderData.refresh();
                    },
                    onError(error) {
                        updateState({
                            saveError: extractErrorMessage(error),
                        });
                    },
                }),
            };
        }

        async function load() {
            const writers = host.instanceState.writers || createWriters();
            updateState({
                writers,
                loadError: '',
            });
            try {
                /** Edits from the last time the modal was open land before the fresh read. */
                await writers.settings.flush();
                const [
                    settings,
                    onboardingStatus,
                ] = await Promise.all([
                    fetchApi(settingsEndpoint, HttpMethod.Get),
                    fetchApi(onboardingEndpoint, HttpMethod.Get).catch(() => undefined),
                ]);
                updateState({
                    settings,
                    onboardingStatus,
                });
            } catch (error: unknown) {
                updateState({
                    loadError: extractErrorMessage(error),
                });
            }
        }

        function changeSettings(update: ValueUpdate<Settings>) {
            const settings = host.instanceState.settings;
            if (!settings || !state.writers) {
                return;
            }
            updateState({
                settings: update(settings),
            });
            state.writers.settings.add(update);
        }

        async function close() {
            inputs.isSettingsOpen.setValue(false);
            updateState({
                closedTarget: target,
                scrollbackDraft: undefined,
                daemonRestartError: '',
            });
            await state.writers?.settings.flush();
        }

        async function restartDaemon() {
            if (
                state.isRestartingDaemon ||
                !window.confirm(
                    'Restart the PTY daemon? All running terminal sessions will be killed.',
                )
            ) {
                return;
            }
            updateState({
                isRestartingDaemon: true,
                daemonRestartError: '',
            });
            try {
                await fetchApi(restartDaemonEndpoint, HttpMethod.Post);
                updateState({
                    isRestartingDaemon: false,
                });
            } catch (error: unknown) {
                updateState({
                    isRestartingDaemon: false,
                    daemonRestartError: extractErrorMessage(error),
                });
            }
        }

        async function setStartAtLogin(isEnabled: boolean) {
            try {
                updateState({
                    onboardingStatus: await fetchApi(startAtLoginEndpoint, HttpMethod.Post, {
                        requestData: {
                            isEnabled,
                        },
                    }),
                    startAtLoginError: '',
                });
            } catch (error: unknown) {
                updateState({
                    startAtLoginError: extractErrorMessage(error),
                });
            }
        }

        async function installClaudeHooks() {
            if (state.isInstallingClaudeHooks || state.onboardingStatus?.areClaudeHooksInstalled) {
                return;
            }
            updateState({
                isInstallingClaudeHooks: true,
                claudeHooksError: '',
            });
            try {
                updateState({
                    onboardingStatus: await fetchApi(claudeHooksInstallEndpoint, HttpMethod.Post),
                    isInstallingClaudeHooks: false,
                });
            } catch (error: unknown) {
                updateState({
                    isInstallingClaudeHooks: false,
                    claudeHooksError: extractErrorMessage(error),
                });
            }
        }

        function setScrollbackLimit(text: string) {
            const value = Number(text);
            const isValid =
                !!text &&
                Number.isFinite(value) &&
                value >= scrollbackLimit.min &&
                value <= scrollbackLimit.max;
            const limit = isValid ? Math.round(value) : state.scrollbackLimit;
            if (isValid) {
                localStorageClient.scrollbackLimit.write(limit);
            }
            updateState({
                scrollbackLimit: limit,
                scrollbackDraft: text,
            });
        }

        function setActivityEnabled(activityId: string, isEnabled: boolean) {
            inputs.context.uiLayout.setActivityBar({
                enabledActivities: {
                    ...inputs.context.uiLayout.value.layout?.enabledActivities,
                    [activityId]: isEnabled,
                },
            });
        }

        const enabledActivityCount = inputs.context.activities.filter((activity) => {
            return isActivityEnabled(inputs.context, activity);
        }).length;

        /**
         * WebKit clamps the scroll of a view that got shorter without firing `scrollend`, which
         * would leave a stale position to restore on the next open.
         */
        function scrollToTop() {
            if (state.contentElement) {
                state.contentElement.scrollTop = 0;
            }
            updateState({
                contentScrollTop: 0,
            });
        }

        function openSection(section: string) {
            scrollToTop();
            updateState({
                search: '',
            });
            inputs.settingsTarget.setValue({
                ...target,
                section,
            });
        }

        /** Every row the modal renders itself, so search can show each one outside its section. */
        function buildEntries(settings: Readonly<Settings>): ReadonlyArray<SettingsEntry> {
            const isScrollbackDraftValid =
                state.scrollbackDraft == undefined ||
                Number(state.scrollbackDraft) === state.scrollbackLimit;
            const scrollbackDescription = `Lines each terminal keeps, from ${scrollbackLimit.min.toLocaleString()} to ${scrollbackLimit.max.toLocaleString()}. Stored in this browser.`;
            const restartDescription =
                'Kills every running terminal session and starts the daemon that holds them again.';
            const startAtLoginDescription =
                'Starts agent-storm in the background when you log in. Takes effect at your next login.';
            const claudeHooksDescription =
                "Lets each AI tab resume its own conversation and show when Claude is working. Adds agent-storm's hooks to ~/.claude/settings.json beside your own.";

            return [
                {
                    section: SettingsSection.General,
                    cardTitle: undefined,
                    searchText: [
                        'Theme',
                        'light dark auto',
                    ],
                    template: html`
                        <${VirSettingsRow.assign({
                            rowTitle: 'Theme',
                            description: 'Stored in this browser.',
                        })}>
                            <${ViraThemeSwitcher.assign({
                                themeClient: inputs.context.themeClient,
                            })}></${ViraThemeSwitcher}>
                        </${VirSettingsRow}>
                    `,
                },
                {
                    section: SettingsSection.General,
                    cardTitle: undefined,
                    searchText: [
                        'Terminal scrollback limit',
                        scrollbackDescription,
                    ],
                    template: html`
                        <${VirSettingsRow.assign({
                            rowTitle: 'Terminal scrollback limit',
                            description: scrollbackDescription,
                            isModified: state.scrollbackLimit !== scrollbackLimit.default,
                        })}
                            ${listen(VirSettingsRow.events.reset, () => {
                                setScrollbackLimit(String(scrollbackLimit.default));
                            })}
                        >
                            <${ViraInput.assign({
                                value: state.scrollbackDraft ?? String(state.scrollbackLimit),
                                type: ViraInputType.Number,
                                hasError: !isScrollbackDraftValid,
                            })}
                                ${listen(ViraInput.events.valueChange, (event) => {
                                    setScrollbackLimit(event.detail);
                                })}
                            ></${ViraInput}>
                        </${VirSettingsRow}>
                    `,
                },
                ...inputs.context.activities.map((activity): SettingsEntry => {
                    const rowTitle = activity.label;
                    const isEnabled = isActivityEnabled(inputs.context, activity);
                    /** With every activity off, the app would have nothing to show. */
                    const isLastEnabled = isEnabled && enabledActivityCount === 1;
                    return {
                        section: SettingsSection.Activities,
                        cardTitle: undefined,
                        searchText: [
                            rowTitle,
                        ],
                        template: html`
                            <${VirSettingsRow.assign({
                                rowTitle,
                                description: '',
                                isModified: isEnabled !== activity.isEnabledByDefault,
                            })}
                                ${listen(VirSettingsRow.events.reset, () => {
                                    setActivityEnabled(activity.id, activity.isEnabledByDefault);
                                })}
                            >
                                <${ViraCheckbox.assign({
                                    value: isEnabled,
                                    isDisabled: isLastEnabled,
                                })}
                                    ${listen(ViraCheckbox.events.valueChange, (event) => {
                                        setActivityEnabled(activity.id, event.detail);
                                    })}
                                ></${ViraCheckbox}>
                            </${VirSettingsRow}>
                        `,
                    };
                }),
                ...sections.flatMap((section) => {
                    return section.schemaKeys.map((key): SettingsEntry => {
                        const schema = settingsJsonSchema.properties[key];
                        return {
                            section: section.id,
                            cardTitle: section.schemaCardTitle,
                            searchText: [
                                schema.title,
                                schema.description,
                            ],
                            template: html`
                                <${VirSettingsSchemaRow.assign({
                                    schema,
                                    value: settings[key],
                                    defaultValue: defaultSettings[key],
                                    errorMessage:
                                        key === 'tlsCertPath' ? state.tlsCertPathError : undefined,
                                })}
                                    ${listen(VirSettingsSchemaRow.events.valueChange, (event) => {
                                        changeSettings((current) => {
                                            return {
                                                ...current,
                                                [key]: event.detail,
                                            };
                                        });
                                    })}
                                ></${VirSettingsSchemaRow}>
                            `,
                        };
                    });
                }),
                ...forgeCards.flatMap((card) => {
                    return card.properties.map(
                        ([
                            key,
                            schema,
                        ]): SettingsEntry => {
                            return {
                                section: SettingsSection.Forges,
                                cardTitle: card.title,
                                searchText: [
                                    schema.title,
                                    schema.description,
                                ],
                                template: html`
                                    <${VirSettingsSchemaRow.assign({
                                        schema,
                                        value: readForgeSetting(settings, card.forgeType, key),
                                        defaultValue: schema.default,
                                    })}
                                        ${listen(
                                            VirSettingsSchemaRow.events.valueChange,
                                            (event) => {
                                                changeSettings((current) => {
                                                    return setForgeSettings(
                                                        current,
                                                        card.forgeType,
                                                        {
                                                            [key]: event.detail,
                                                        },
                                                    );
                                                });
                                            },
                                        )}
                                    ></${VirSettingsSchemaRow}>
                                `,
                            };
                        },
                    );
                }),
                ...(state.onboardingStatus?.canStartAtLogin
                    ? [
                          {
                              section: SettingsSection.General,
                              cardTitle: undefined,
                              searchText: [
                                  'Start at login',
                                  startAtLoginDescription,
                              ],
                              template: html`
                                  <${VirSettingsRow.assign({
                                      rowTitle: 'Start at login',
                                      description: startAtLoginDescription,
                                      errorMessage: state.startAtLoginError,
                                  })}>
                                      <${ViraCheckbox.assign({
                                          value: state.onboardingStatus.isStartAtLoginEnabled,
                                      })}
                                          ${listen(
                                              ViraCheckbox.events.valueChange,
                                              async (event) => {
                                                  await setStartAtLogin(event.detail);
                                              },
                                          )}
                                      ></${ViraCheckbox}>
                                  </${VirSettingsRow}>
                              `,
                          } satisfies SettingsEntry,
                      ]
                    : []),
                ...(state.onboardingStatus?.canInstallClaudeHooks
                    ? [
                          {
                              section: SettingsSection.Maintenance,
                              cardTitle: undefined,
                              searchText: [
                                  'Claude Code hooks',
                                  claudeHooksDescription,
                              ],
                              template: html`
                                  <${VirSettingsRow.assign({
                                      rowTitle: 'Claude Code hooks',
                                      description: claudeHooksDescription,
                                      errorMessage: state.claudeHooksError,
                                  })}>
                                      <${ViraButton.assign({
                                          text: state.onboardingStatus.areClaudeHooksInstalled
                                              ? 'Installed'
                                              : state.isInstallingClaudeHooks
                                                ? 'Installing...'
                                                : 'Install',
                                          buttonSize: ViraSize.Small,
                                          isDisabled:
                                              state.isInstallingClaudeHooks ||
                                              state.onboardingStatus.areClaudeHooksInstalled,
                                      })}
                                          ${listen('click', installClaudeHooks)}
                                      ></${ViraButton}>
                                  </${VirSettingsRow}>
                              `,
                          } satisfies SettingsEntry,
                      ]
                    : []),
                {
                    section: SettingsSection.Maintenance,
                    cardTitle: undefined,
                    searchText: [
                        'Restart PTY daemon',
                        restartDescription,
                    ],
                    template: html`
                        <${VirSettingsRow.assign({
                            rowTitle: 'Restart PTY daemon',
                            description: restartDescription,
                            errorMessage: state.daemonRestartError,
                        })}>
                            <${ViraButton.assign({
                                text: state.isRestartingDaemon ? 'Restarting...' : 'Restart',
                                color: ViraColorVariant.Danger,
                                buttonSize: ViraSize.Small,
                                isDisabled: state.isRestartingDaemon,
                            })}
                                ${listen('click', restartDaemon)}
                            ></${ViraButton}>
                        </${VirSettingsRow}>
                    `,
                },
            ];
        }

        /** Puts consecutive entries that share a card title into one card. */
        function renderEntries(entries: ReadonlyArray<SettingsEntry>) {
            return entries
                .reduce<
                    ReadonlyArray<
                        Readonly<{title: string | undefined; entries: ReadonlyArray<SettingsEntry>}>
                    >
                >((cards, entry) => {
                    const lastCard = cards.at(-1);
                    return lastCard && lastCard.title === entry.cardTitle
                        ? [
                              ...cards.slice(0, -1),
                              {
                                  title: lastCard.title,
                                  entries: [
                                      ...lastCard.entries,
                                      entry,
                                  ],
                              },
                          ]
                        : [
                              ...cards,
                              {
                                  title: entry.cardTitle,
                                  entries: [
                                      entry,
                                  ],
                              },
                          ];
                }, [])
                .map((card) => {
                    return html`
                        ${card.title
                            ? html`
                                  <span class="card-title">${card.title}</span>
                              `
                            : nothing}
                        <div class="card">
                            ${card.entries.map((entry) => {
                                return entry.template;
                            })}
                        </div>
                    `;
                });
        }

        const sectionContent: Readonly<
            Record<
                SettingsSection,
                (
                    params: Readonly<{
                        settings: Readonly<Settings>;
                        entries: ReadonlyArray<SettingsEntry>;
                    }>,
                ) => HtmlInterpolation
            >
        > = {
            [SettingsSection.General]({entries}) {
                return renderEntries(entries);
            },
            [SettingsSection.Terminal]({entries}) {
                return renderEntries(entries);
            },
            [SettingsSection.Sidebar]({entries}) {
                return renderEntries(entries);
            },
            [SettingsSection.Activities]({entries}) {
                return renderEntries(entries);
            },
            [SettingsSection.Ai]({settings}) {
                return html`
                    <${VirSettingsAi.assign({
                        settings,
                    })}
                        ${listen(VirSettingsAi.events.settingsChange, (event) => {
                            changeSettings(event.detail);
                        })}
                    ></${VirSettingsAi}>
                `;
            },
            [SettingsSection.Folders]({settings, entries}) {
                return html`
                    ${renderEntries(entries)}
                    <${VirSettingsFolders.assign({
                        settings,
                        folderInfo: inputs.context.folderData.value.folderInfo,
                        folder: target.folder,
                    })}
                        ${listen(VirSettingsFolders.events.settingsChange, (event) => {
                            changeSettings(event.detail);
                        })}
                        ${listen(VirSettingsFolders.events.folderSelect, (event) => {
                            inputs.settingsTarget.setValue({
                                section: SettingsSection.Folders,
                                folder: event.detail,
                            });
                        })}
                    ></${VirSettingsFolders}>
                `;
            },
            [SettingsSection.Forges]({entries}) {
                return renderEntries(entries);
            },
            [SettingsSection.Maintenance]({entries}) {
                return renderEntries(entries);
            },
        };

        /**
         * Each section with a matching setting, holding only those settings. A section whose own
         * name or search terms match shows all of its settings, or just a way to open it when its
         * settings live in their own element.
         */
        function renderSearchResults(entries: ReadonlyArray<SettingsEntry>) {
            const results = sections
                .map((section) => {
                    const isSectionMatch = matchesSearch([
                        section.label,
                        ...section.searchTerms,
                    ]);
                    const sectionEntries = entries.filter((entry) => entry.section === section.id);
                    return {
                        section,
                        isSectionMatch,
                        matches: isSectionMatch
                            ? sectionEntries
                            : sectionEntries.filter((entry) => {
                                  return matchesSearch([
                                      entry.cardTitle,
                                      ...entry.searchText,
                                  ]);
                              }),
                    };
                })
                .filter(({isSectionMatch, matches}) => isSectionMatch || matches.length);

            if (!results.length) {
                return html`
                    <span class="muted">No settings match "${state.search}".</span>
                `;
            }

            return results.map(({section, matches}) => {
                return html`
                    <div class="result-section">
                        <div class="result-header">
                            <h3>${section.label}</h3>
                            <${ViraButton.assign({
                                text: 'Open',
                                buttonSize: ViraSize.Small,
                                buttonEmphasis: ViraEmphasis.Subtle,
                                color: ViraColorVariant.Neutral,
                            })}
                                ${listen('click', () => {
                                    openSection(section.id);
                                })}
                            ></${ViraButton}>
                        </div>
                        ${renderEntries(matches)}
                    </div>
                `;
            });
        }

        function renderContent(section: SettingsSectionPage) {
            if (!state.settings) {
                return state.loadError
                    ? nothing
                    : html`
                          <span class="muted">Loading...</span>
                      `;
            }
            const entries = buildEntries(state.settings);
            const sectionEntries = entries.filter((entry) => entry.section === section.id);
            return isSearching
                ? renderSearchResults(entries)
                : section.render
                  ? section.render({
                        settings: state.settings,
                        details: target.details,
                        changeSettings,
                    })
                  : check.isEnumValue(section.id, SettingsSection)
                    ? sectionContent[section.id]({
                          settings: state.settings,
                          entries: sectionEntries,
                      })
                    : renderEntries(sectionEntries);
        }

        function renderBody(section: SettingsSectionPage) {
            const defaults = isSearching
                ? undefined
                : customSectionDefaults[section.id] || createSchemaDefaults(section);
            const isMobile = inputs.context.screenSize === ScreenSize.Mobile;

            return html`
                <div class="body ${isMobile ? 'mobile' : ''}">
                    <div class="nav">
                        <${ViraInput.assign({
                            value: state.search,
                            placeholder: 'Search settings',
                            icon: LucideSearchIcon,
                            showClearButton: true,
                        })}
                            ${listen(ViraInput.events.valueChange, (event) => {
                                scrollToTop();
                                updateState({
                                    search: event.detail,
                                });
                            })}
                        ></${ViraInput}>
                        <${ViraTabs.assign({
                            tabs: sections.map((tabSection) => {
                                return {
                                    label: tabSection.label,
                                    group: tabSection.group,
                                    paths: {
                                        path: tabSection.id,
                                        fullPaths: [
                                            tabSection.id,
                                        ],
                                        PathsType: [
                                            tabSection.id,
                                        ],
                                    },
                                };
                            }),
                            router: staticTabRouter,
                            currentRoute: toStaticTabRoute(isSearching ? undefined : section.id),
                            barDirection: isMobile
                                ? ViraTabsBarDirection.Bottom
                                : ViraTabsBarDirection.Right,
                            shouldFillWidth: !isMobile,
                            color: ViraThemeColorName.blue,
                        })}
                            ${listen(ViraTabs.events.tabSelect, (event) => {
                                const selected = event.detail.paths.fullPaths[0];
                                if (check.isString(selected)) {
                                    openSection(selected);
                                }
                            })}
                        ></${ViraTabs}>
                    </div>
                    <div
                        class="content"
                        ${onDomCreated((element) => {
                            updateState({
                                contentElement: assertWrap.instanceOf(element, HTMLElement),
                            });
                        })}
                        ${listen('scrollend', (event) => {
                            updateState({
                                contentScrollTop: extractEventTarget(event, HTMLElement).scrollTop,
                            });
                        })}
                    >
                        <div class="header">
                            <h2>${isSearching ? 'Search results' : section.label}</h2>
                            ${defaults && state.settings && defaults.isModified(state.settings)
                                ? html`
                                      <${ViraButton.assign({
                                          text: 'Restore defaults',
                                          buttonSize: ViraSize.Small,
                                          buttonEmphasis: ViraEmphasis.Subtle,
                                          color: ViraColorVariant.Neutral,
                                      })}
                                          ${listen('click', () => {
                                              changeSettings(defaults.restore);
                                          })}
                                      ></${ViraButton}>
                                  `
                                : nothing}
                        </div>
                        ${[
                            state.loadError,
                            state.saveError,
                        ]
                            .filter(Boolean)
                            .map((message) => {
                                return html`
                                    <div class="error">${message}</div>
                                `;
                            })}
                        ${renderContent(section)}
                    </div>
                </div>
            `;
        }

        const shownSection = assertWrap.isDefined(
            findSettingsSection({
                sections,
                id: target.section,
            }),
        );
        const searchText = state.search.trim().toLowerCase();
        const isSearching = !!searchText;

        function matchesSearch(texts: ReadonlyArray<string | undefined>) {
            return texts.join('\n').toLowerCase().includes(searchText);
        }

        return html`
            <${ViraModal.assign({
                open: isOpen,
                modalTitle: 'Settings',
                isMobileSize: inputs.context.screenSize === ScreenSize.Mobile,
            })}
                ${listen(ViraModal.events.modalClose, close)}
            >
                ${isOpen || state.closedTarget ? renderBody(shownSection) : nothing}
            </${ViraModal}>
        `;
    },
});
