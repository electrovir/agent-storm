// cspell:words forgejo, gitea

import {
    checkPathEndpoint,
    configEndpoint,
    configJsonSchema,
    defaultConfig,
    ForgeType,
    restartDaemonEndpoint,
    reviewConfigEndpoint,
    type Config,
    type ReviewConfig,
} from '@agent-storm/common';
import {assertWrap, check} from '@augment-vir/assert';
import {
    extractErrorMessage,
    getEnumValues,
    getObjectTypedEntries,
    mapEnumToObject,
    pickObjectKeys,
    type JsonValue,
} from '@augment-vir/common';
import {extractEventTarget} from '@augment-vir/web';
import {HttpMethod} from '@rest-vir/api';
import {css, html, listen, nothing, onDomCreated, type HtmlInterpolation} from 'element-vir';
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
import {activityInfo, isActivityEnabled} from '../../util/activity-info.js';
import {fetchApi} from '../../util/api-client.js';
import {SettingsSection, type AppContext, type SettingsTarget} from '../../util/app-context.js';
import {createBatchedWriter, type ValueUpdate} from '../../util/batched-writer.js';
import {localStorageClient, scrollbackLimit} from '../../util/local-storage-client.js';
import {orderedActivityIds, type ActivityId} from '../../util/router.js';
import {ScreenSize} from '../../util/screen-size.js';
import {schemaConfigKeySections, settingsSections} from '../../util/settings-sections.js';
import {staticTabRouter, toStaticTabRoute} from '../../util/static-tab-router.js';
import {defineAppElement} from '../define-app-element.js';
import {VirSettingsAi} from './vir-settings-ai.element.js';
import {VirSettingsFolders} from './vir-settings-folders.element.js';
import {VirSettingsReview} from './vir-settings-review.element.js';
import {settingsCardCss, VirSettingsRow} from './vir-settings-row.element.js';
import {VirSettingsSchemaRow, type SettingSchema} from './vir-settings-schema-row.element.js';

/** `githubPollingAutoDisable` is backend-managed, so the user has no business editing it. */
const hiddenForgeConfigKeys = {
    [ForgeType.Github]: [
        'githubPollingAutoDisable',
    ],
    [ForgeType.Gitea]: [],
    [ForgeType.Forgejo]: [],
    [ForgeType.Gitlab]: [],
} as const satisfies {
    [Forge in ForgeType]: ReadonlyArray<keyof Config['forges'][Forge]>;
};

/** Each forge with settings to show. A forge with none gets no card. */
const forgeCards = getEnumValues(ForgeType)
    .map((forgeType) => {
        const forgeSchema = configJsonSchema.properties.forges.properties[forgeType];
        return {
            forgeType,
            title: forgeSchema.title,
            properties: getObjectTypedEntries(
                forgeSchema.properties satisfies object as Readonly<
                    Record<string, SettingSchema & Readonly<{default: unknown}>>
                >,
            ).filter(([key]) => {
                return !(hiddenForgeConfigKeys[forgeType] as ReadonlyArray<string>).includes(key);
            }),
        };
    })
    .filter((card) => card.properties.length);

function getSchemaKeys(section: SettingsSection) {
    return getObjectTypedEntries(schemaConfigKeySections)
        .filter(
            ([
                ,
                keySection,
            ]) => keySection === section,
        )
        .map(([key]) => key);
}

function readForgeSetting(config: Readonly<Config>, forgeType: ForgeType, key: string) {
    return (config.forges[forgeType] satisfies object as Readonly<Record<string, unknown>>)[key];
}

function setForgeSettings(
    config: Readonly<Config>,
    forgeType: ForgeType,
    settings: Readonly<Record<string, unknown>>,
): Config {
    return {
        ...config,
        forges: {
            ...config.forges,
            [forgeType]: {
                ...config.forges[forgeType],
                ...settings,
            },
        } satisfies Record<ForgeType, object> as Config['forges'],
    };
}

/** One row of settings that search can show outside its section. */
type SettingsEntry = Readonly<{
    section: SettingsSection;
    /** Consecutive entries with the same title share a card, titled when this is set. */
    cardTitle: string | undefined;
    /** The row's title and description, which search matches. */
    searchText: ReadonlyArray<string | undefined>;
    template: HtmlInterpolation;
}>;

function isDefault({value, defaultValue}: Readonly<{value: unknown; defaultValue: unknown}>) {
    return check.jsonEquals((value ?? null) as JsonValue, (defaultValue ?? null) as JsonValue);
}

/** Puts a section's settings back to their defaults. Undefined for a section with none. */
const sectionDefaults: Readonly<
    Record<
        SettingsSection,
        | Readonly<{
              isModified: (config: Readonly<Config>) => boolean;
              restore: ValueUpdate<Config>;
          }>
        | undefined
    >
> = {
    ...mapEnumToObject(SettingsSection, (section) => {
        const keys = getSchemaKeys(section);
        return keys.length
            ? {
                  isModified(config: Readonly<Config>) {
                      return keys.some((key) => {
                          return !isDefault({
                              value: config[key],
                              defaultValue: defaultConfig[key],
                          });
                      });
                  },
                  restore(config: Readonly<Config>): Config {
                      return {
                          ...config,
                          ...pickObjectKeys(defaultConfig, keys),
                      };
                  },
              }
            : undefined;
    }),
    [SettingsSection.Forges]: {
        isModified(config) {
            return forgeCards.some((card) => {
                return card.properties.some(
                    ([
                        key,
                        schema,
                    ]) => {
                        return !isDefault({
                            value: readForgeSetting(config, card.forgeType, key),
                            defaultValue: schema.default,
                        });
                    },
                );
            });
        },
        restore(config) {
            return forgeCards.reduce((current, card) => {
                return setForgeSettings(
                    current,
                    card.forgeType,
                    Object.fromEntries(
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
            }, config);
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
}>()({
    tagName: 'vir-settings-modal',
    state() {
        return {
            config: undefined as Config | undefined,
            reviewConfig: undefined as ReviewConfig | undefined,
            writers: undefined as
                | Readonly<{
                      config: ReturnType<typeof createBatchedWriter<Config>>;
                      reviewConfig: ReturnType<typeof createBatchedWriter<ReviewConfig>>;
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
        const target = inputs.context.settingsTarget.value;
        const isOpen = inputs.context.isSettingsOpen.value;
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
                config: createBatchedWriter<Config>({
                    delay: {
                        milliseconds: 400,
                    },
                    read() {
                        return fetchApi(configEndpoint, HttpMethod.Get);
                    },
                    write(requestData) {
                        return fetchApi(configEndpoint, HttpMethod.Put, {
                            requestData,
                        });
                    },
                    async onSaved({previous, saved, pending}) {
                        updateState({
                            config: pending.reduce((value: Config, update) => update(value), saved),
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
                reviewConfig: createBatchedWriter<ReviewConfig>({
                    delay: {
                        milliseconds: 400,
                    },
                    read() {
                        return fetchApi(reviewConfigEndpoint, HttpMethod.Get);
                    },
                    write(requestData) {
                        return fetchApi(reviewConfigEndpoint, HttpMethod.Put, {
                            requestData,
                        });
                    },
                    onSaved({saved, pending}) {
                        updateState({
                            reviewConfig: pending.reduce(
                                (value: ReviewConfig, update) => update(value),
                                saved,
                            ),
                            saveError: '',
                        });
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
                await Promise.all([
                    writers.config.flush(),
                    writers.reviewConfig.flush(),
                ]);
                const [
                    config,
                    reviewConfig,
                ] = await Promise.all([
                    fetchApi(configEndpoint, HttpMethod.Get),
                    fetchApi(reviewConfigEndpoint, HttpMethod.Get),
                ]);
                updateState({
                    config,
                    reviewConfig,
                });
            } catch (error: unknown) {
                updateState({
                    loadError: extractErrorMessage(error),
                });
            }
        }

        function changeConfig(update: ValueUpdate<Config>) {
            const config = host.instanceState.config;
            if (!config || !state.writers) {
                return;
            }
            updateState({
                config: update(config),
            });
            state.writers.config.add(update);
        }

        function changeReviewConfig(update: ValueUpdate<ReviewConfig>) {
            const reviewConfig = host.instanceState.reviewConfig;
            if (!reviewConfig || !state.writers) {
                return;
            }
            updateState({
                reviewConfig: update(reviewConfig),
            });
            state.writers.reviewConfig.add(update);
        }

        async function close() {
            inputs.context.isSettingsOpen.setValue(false);
            updateState({
                closedTarget: target,
                scrollbackDraft: undefined,
                daemonRestartError: '',
            });
            await Promise.all([
                state.writers?.config.flush(),
                state.writers?.reviewConfig.flush(),
            ]);
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

        function setActivityEnabled(activityId: ActivityId, isEnabled: boolean) {
            inputs.context.uiLayout.setActivityBar({
                enabledActivities: {
                    ...inputs.context.uiLayout.value.layout?.enabledActivities,
                    [activityId]: isEnabled,
                },
            });
        }

        const enabledActivityIds = orderedActivityIds.filter((activityId) => {
            return isActivityEnabled(inputs.context, activityId);
        });

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

        function openSection(section: SettingsSection) {
            scrollToTop();
            updateState({
                search: '',
            });
            inputs.context.settingsTarget.setValue({
                ...target,
                section,
            });
        }

        /** Every row the modal renders itself, so search can show each one outside its section. */
        function buildEntries(config: Readonly<Config>): ReadonlyArray<SettingsEntry> {
            const isScrollbackDraftValid =
                state.scrollbackDraft == undefined ||
                Number(state.scrollbackDraft) === state.scrollbackLimit;
            const scrollbackDescription = `Lines each terminal keeps, from ${scrollbackLimit.min.toLocaleString()} to ${scrollbackLimit.max.toLocaleString()}. Stored in this browser.`;
            const restartDescription =
                'Kills every running terminal session and starts the daemon that holds them again.';

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
                ...orderedActivityIds.map((activityId): SettingsEntry => {
                    const rowTitle = activityInfo[activityId].label;
                    const isEnabled = enabledActivityIds.includes(activityId);
                    /** With every activity off, the app would have nothing to show. */
                    const isLastEnabled = isEnabled && enabledActivityIds.length === 1;
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
                                isModified:
                                    isEnabled !== activityInfo[activityId].isEnabledByDefault,
                            })}
                                ${listen(VirSettingsRow.events.reset, () => {
                                    setActivityEnabled(
                                        activityId,
                                        activityInfo[activityId].isEnabledByDefault,
                                    );
                                })}
                            >
                                <${ViraCheckbox.assign({
                                    value: isEnabled,
                                    isDisabled: isLastEnabled,
                                })}
                                    ${listen(ViraCheckbox.events.valueChange, (event) => {
                                        setActivityEnabled(activityId, event.detail);
                                    })}
                                ></${ViraCheckbox}>
                            </${VirSettingsRow}>
                        `,
                    };
                }),
                ...getObjectTypedEntries(schemaConfigKeySections).map(
                    ([
                        key,
                        section,
                    ]): SettingsEntry => {
                        const schema = configJsonSchema.properties[key];
                        return {
                            section,
                            cardTitle: settingsSections[section].schemaCardTitle,
                            searchText: [
                                schema.title,
                                schema.description,
                            ],
                            template: html`
                                <${VirSettingsSchemaRow.assign({
                                    schema,
                                    value: config[key],
                                    defaultValue: defaultConfig[key],
                                    errorMessage:
                                        key === 'tlsCertPath' ? state.tlsCertPathError : undefined,
                                })}
                                    ${listen(VirSettingsSchemaRow.events.valueChange, (event) => {
                                        changeConfig((current) => {
                                            return {
                                                ...current,
                                                [key]: event.detail,
                                            };
                                        });
                                    })}
                                ></${VirSettingsSchemaRow}>
                            `,
                        };
                    },
                ),
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
                                        value: readForgeSetting(config, card.forgeType, key),
                                        defaultValue: schema.default,
                                    })}
                                        ${listen(
                                            VirSettingsSchemaRow.events.valueChange,
                                            (event) => {
                                                changeConfig((current) => {
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
                        config: Readonly<Config>;
                        reviewConfig: Readonly<ReviewConfig>;
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
            [SettingsSection.Diff]({entries}) {
                return renderEntries(entries);
            },
            [SettingsSection.Activities]({entries}) {
                return renderEntries(entries);
            },
            [SettingsSection.Ai]({config}) {
                return html`
                    <${VirSettingsAi.assign({
                        config,
                    })}
                        ${listen(VirSettingsAi.events.configChange, (event) => {
                            changeConfig(event.detail);
                        })}
                    ></${VirSettingsAi}>
                `;
            },
            [SettingsSection.Folders]({config, entries}) {
                return html`
                    ${renderEntries(entries)}
                    <${VirSettingsFolders.assign({
                        config,
                        folderInfo: inputs.context.folderData.value.folderInfo,
                        folder: target.folder,
                    })}
                        ${listen(VirSettingsFolders.events.configChange, (event) => {
                            changeConfig(event.detail);
                        })}
                        ${listen(VirSettingsFolders.events.folderSelect, (event) => {
                            inputs.context.settingsTarget.setValue({
                                section: SettingsSection.Folders,
                                folder: event.detail,
                            });
                        })}
                    ></${VirSettingsFolders}>
                `;
            },
            [SettingsSection.Review]({reviewConfig}) {
                return html`
                    <${VirSettingsReview.assign({
                        reviewConfig,
                        reviewRepo: target.reviewRepo,
                    })}
                        ${listen(VirSettingsReview.events.reviewConfigChange, (event) => {
                            changeReviewConfig(event.detail);
                        })}
                    ></${VirSettingsReview}>
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
            const results = getEnumValues(SettingsSection)
                .map((section) => {
                    const isSectionMatch = matchesSearch([
                        settingsSections[section].label,
                        ...settingsSections[section].searchTerms,
                    ]);
                    const sectionEntries = entries.filter((entry) => entry.section === section);
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
                            <h3>${settingsSections[section].label}</h3>
                            <${ViraButton.assign({
                                text: 'Open',
                                buttonSize: ViraSize.Small,
                                buttonEmphasis: ViraEmphasis.Subtle,
                                color: ViraColorVariant.Neutral,
                            })}
                                ${listen('click', () => {
                                    openSection(section);
                                })}
                            ></${ViraButton}>
                        </div>
                        ${renderEntries(matches)}
                    </div>
                `;
            });
        }

        function renderContent(section: SettingsSection) {
            if (!state.config || !state.reviewConfig) {
                return state.loadError
                    ? nothing
                    : html`
                          <span class="muted">Loading...</span>
                      `;
            }
            const entries = buildEntries(state.config);
            return isSearching
                ? renderSearchResults(entries)
                : sectionContent[section]({
                      config: state.config,
                      reviewConfig: state.reviewConfig,
                      entries: entries.filter((entry) => entry.section === section),
                  });
        }

        function renderBody(section: SettingsSection) {
            const defaults = isSearching ? undefined : sectionDefaults[section];
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
                            tabs: getEnumValues(SettingsSection).map((tabSection) => {
                                return {
                                    label: settingsSections[tabSection].label,
                                    group: settingsSections[tabSection].group,
                                    paths: {
                                        path: tabSection,
                                        fullPaths: [
                                            tabSection,
                                        ],
                                        PathsType: [
                                            tabSection,
                                        ],
                                    },
                                };
                            }),
                            router: staticTabRouter,
                            currentRoute: toStaticTabRoute(isSearching ? undefined : section),
                            barDirection: isMobile
                                ? ViraTabsBarDirection.Bottom
                                : ViraTabsBarDirection.Right,
                            shouldFillWidth: !isMobile,
                            color: ViraThemeColorName.blue,
                        })}
                            ${listen(ViraTabs.events.tabSelect, (event) => {
                                const selected = event.detail.paths.fullPaths[0];
                                if (check.isEnumValue(selected, SettingsSection)) {
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
                            <h2>
                                ${isSearching ? 'Search results' : settingsSections[section].label}
                            </h2>
                            ${defaults && state.config && defaults.isModified(state.config)
                                ? html`
                                      <${ViraButton.assign({
                                          text: 'Restore defaults',
                                          buttonSize: ViraSize.Small,
                                          buttonEmphasis: ViraEmphasis.Subtle,
                                          color: ViraColorVariant.Neutral,
                                      })}
                                          ${listen('click', () => {
                                              changeConfig(defaults.restore);
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
                ${isOpen || state.closedTarget ? renderBody(target.section) : nothing}
            </${ViraModal}>
        `;
    },
});
