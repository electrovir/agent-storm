import {defaultSettings, FontRole, type Settings} from '@agent-storm/common';
import {
    defaultFontFamilies,
    defaultFontPreviewSizes,
    defineAppElement,
    fontRoleFollows,
    fontRoleIsMonospace,
    fontSizeLimits,
    resolveFonts,
    settingsCardCss,
    VirSettingsRow,
    type ValueUpdate,
} from '@agent-storm/core/frontend';
import {extractErrorMessage, getEnumValues} from '@augment-vir/common';
import {css, defineElementEvent, html, listen, nothing, unsafeCSS} from 'element-vir';
import {
    ViraButton,
    ViraCheckbox,
    ViraColorVariant,
    ViraDropdown,
    ViraEmphasis,
    ViraInput,
    ViraInputType,
    viraThemeByKeys,
} from 'vira';
import {
    canQueryLocalFonts,
    isMonospaceFamily,
    queryLocalFontFamilies,
} from '../../util/local-fonts.js';

const roleLabels: Readonly<Record<FontRole, Readonly<{title: string; description: string}>>> = {
    [FontRole.Interface]: {
        title: 'Interface',
        description: 'Labels, lists, and controls throughout the app.',
    },
    [FontRole.Prompt]: {
        title: 'Prompt',
        description: 'Text you type to comment on code.',
    },
    [FontRole.Code]: {
        title: 'Code',
        description: 'The Diff and Review panes.',
    },
    [FontRole.Terminal]: {
        title: 'Terminal',
        description: 'The AI and Shell tabs.',
    },
};

const previewText = 'The quick brown fox jumps over the lazy dog. 0123456789 {}[]()=>';

/**
 * The Settings modal's Typography section: a family and size for each part of the UI, with a
 * preview of each, plus the settings that apply to all of them.
 */
export const VirSettingsTypography = defineAppElement<{
    settings: Readonly<Settings>;
}>()({
    tagName: 'vir-settings-typography',
    events: {
        settingsChange: defineElementEvent<ValueUpdate<Settings>>(),
    },
    state() {
        return {
            /** Undefined until the user asks the browser to list installed fonts. */
            families: undefined as
                | Readonly<{all: ReadonlyArray<string>; monospace: ReadonlyArray<string>}>
                | undefined,
            isLoadingFamilies: false,
            familiesError: '',
            /** A size input's text, which may be out of bounds while the user types. */
            sizeDrafts: {} as Readonly<Partial<Record<FontRole, string>>>,
        };
    },
    styles: css`
        ${settingsCardCss}

        :host {
            display: flex;
            flex-direction: column;
            gap: 16px;
        }

        .role {
            display: flex;
            flex-direction: column;
            gap: 8px;
        }

        .preview {
            padding: 12px 16px;
            overflow-wrap: anywhere;
        }

        .error {
            color: ${viraThemeByKeys.red.foreground.body.foreground.value};
        }
    `,
    render({inputs, state, updateState, dispatch, events}) {
        const typography = inputs.settings.typography;
        const fonts = resolveFonts(typography);

        function changeSettings(update: ValueUpdate<Settings>) {
            dispatch(
                new events.settingsChange({
                    detail: update,
                }),
            );
        }

        function changeTypography(patch: Partial<Settings['typography']>) {
            changeSettings((current) => {
                return {
                    ...current,
                    typography: {
                        ...current.typography,
                        ...patch,
                    },
                };
            });
        }

        function changeRole({
            role,
            patch,
        }: Readonly<{role: FontRole; patch: Partial<Settings['typography'][FontRole]>}>) {
            changeSettings((current) => {
                return {
                    ...current,
                    typography: {
                        ...current.typography,
                        [role]: {
                            ...current.typography[role],
                            ...patch,
                        },
                    },
                };
            });
        }

        async function loadFamilies() {
            if (state.isLoadingFamilies) {
                return;
            }
            updateState({
                isLoadingFamilies: true,
                familiesError: '',
            });
            try {
                const all = await queryLocalFontFamilies();
                updateState({
                    families: {
                        all,
                        monospace: all.filter(isMonospaceFamily),
                    },
                });
            } catch (error) {
                updateState({
                    familiesError: extractErrorMessage(error),
                });
            } finally {
                updateState({
                    isLoadingFamilies: false,
                });
            }
        }

        function renderFamilyPicker(role: FontRole) {
            const family = typography[role].family;
            const listed = state.families?.[fontRoleIsMonospace[role] ? 'monospace' : 'all'];
            if (!listed) {
                return html`
                    <${ViraInput.assign({
                        value: family,
                        placeholder: 'App default',
                        showClearButton: true,
                        disableBrowserHelps: true,
                    })}
                        ${listen(ViraInput.events.valueChange, (event) => {
                            changeRole({
                                role,
                                patch: {
                                    family: event.detail,
                                },
                            });
                        })}
                    ></${ViraInput}>
                `;
            }
            return html`
                <${ViraDropdown.assign({
                    options: [
                        {
                            value: '',
                            label: 'App default',
                        },
                        ...(family && !listed.includes(family) ? [family] : [])
                            .concat(listed)
                            .map((option) => {
                                return {
                                    value: option,
                                    label: option,
                                };
                            }),
                    ],
                    selected: [
                        family,
                    ],
                    isSearchable: true,
                    maxShownOptions: 100,
                })}
                    ${listen(ViraDropdown.events.selectedValuesChange, (event) => {
                        changeRole({
                            role,
                            patch: {
                                family: event.detail[0] || '',
                            },
                        });
                    })}
                ></${ViraDropdown}>
            `;
        }

        function renderSizeInput(role: FontRole) {
            const limits = fontSizeLimits[role];
            const draft = state.sizeDrafts[role];
            const size = typography[role].size;
            const parsedDraft = draft ? Number(draft) : 0;
            const hasError = !!draft && !(parsedDraft >= limits.min && parsedDraft <= limits.max);
            return html`
                <${ViraInput.assign({
                    value: draft ?? (size ? String(size) : ''),
                    type: ViraInputType.Number,
                    placeholder: 'Default',
                    hasError,
                })}
                    ${listen(ViraInput.events.valueChange, (event) => {
                        updateState({
                            sizeDrafts: {
                                ...state.sizeDrafts,
                                [role]: event.detail,
                            },
                        });
                        const parsed = event.detail ? Number(event.detail) : 0;
                        if (!parsed || (parsed >= limits.min && parsed <= limits.max)) {
                            changeRole({
                                role,
                                patch: {
                                    size: parsed,
                                },
                            });
                        }
                    })}
                ></${ViraInput}>
            `;
        }

        function renderRole(role: FontRole) {
            const limits = fontSizeLimits[role];
            const font = fonts[role];
            return html`
                <div class="role">
                    <span class="card-title">${roleLabels[role].title}</span>
                    <div class="card">
                        <${VirSettingsRow.assign({
                            rowTitle: 'Font family',
                            description: `${roleLabels[role].description}${fontRoleIsMonospace[role] ? ' Monospace fonts only.' : ''}`,
                            isModified:
                                typography[role].family !== defaultSettings.typography[role].family,
                        })}
                            ${listen(VirSettingsRow.events.reset, () => {
                                changeRole({
                                    role,
                                    patch: {
                                        family: defaultSettings.typography[role].family,
                                    },
                                });
                            })}
                        >
                            ${renderFamilyPicker(role)}
                        </${VirSettingsRow}>
                        <${VirSettingsRow.assign({
                            rowTitle: 'Font size',
                            description: `${limits.min} to ${limits.max} pixels. Empty keeps the app's own sizes.`,
                            isModified:
                                typography[role].size !== defaultSettings.typography[role].size,
                        })}
                            ${listen(VirSettingsRow.events.reset, () => {
                                updateState({
                                    sizeDrafts: {
                                        ...state.sizeDrafts,
                                        [role]: undefined,
                                    },
                                });
                                changeRole({
                                    role,
                                    patch: {
                                        size: defaultSettings.typography[role].size,
                                    },
                                });
                            })}
                        >
                            ${renderSizeInput(role)}
                        </${VirSettingsRow}>
                        <div
                            class="preview"
                            style=${css`
                                font-family: ${unsafeCSS(
                                    font.familyCss || defaultFontFamilies[role],
                                )};
                                font-size: ${font.sizePx ?? defaultFontPreviewSizes[role]}px;
                            `}
                        >
                            ${previewText}
                        </div>
                    </div>
                </div>
            `;
        }

        return html`
            <div class="card">
                <${VirSettingsRow.assign({
                    rowTitle: 'Separate fonts',
                    description:
                        'When off, the prompt uses the interface font and the terminal uses the code font.',
                    isModified:
                        typography.separateFonts !== defaultSettings.typography.separateFonts,
                })}
                    ${listen(VirSettingsRow.events.reset, () => {
                        changeTypography({
                            separateFonts: defaultSettings.typography.separateFonts,
                        });
                    })}
                >
                    <${ViraCheckbox.assign({
                        value: typography.separateFonts,
                    })}
                        ${listen(ViraCheckbox.events.valueChange, (event) => {
                            changeTypography({
                                separateFonts: event.detail,
                            });
                        })}
                    ></${ViraCheckbox}>
                </${VirSettingsRow}>
                <${VirSettingsRow.assign({
                    rowTitle: 'Font smoothing',
                    description:
                        "Uses grayscale antialiasing, which looks thinner on macOS. Doesn't affect the terminal.",
                    isModified:
                        typography.fontSmoothing !== defaultSettings.typography.fontSmoothing,
                })}
                    ${listen(VirSettingsRow.events.reset, () => {
                        changeTypography({
                            fontSmoothing: defaultSettings.typography.fontSmoothing,
                        });
                    })}
                >
                    <${ViraCheckbox.assign({
                        value: typography.fontSmoothing,
                    })}
                        ${listen(ViraCheckbox.events.valueChange, (event) => {
                            changeTypography({
                                fontSmoothing: event.detail,
                            });
                        })}
                    ></${ViraCheckbox}>
                </${VirSettingsRow}>
                ${canQueryLocalFonts() && !state.families
                    ? html`
                          <${VirSettingsRow.assign({
                              rowTitle: 'Installed fonts',
                              description:
                                  'Lists the fonts on this machine in the family pickers. Your browser asks for permission first. Until then, type a family name.',
                              errorMessage: state.familiesError,
                          })}>
                              <${ViraButton.assign({
                                  text: 'List installed fonts',
                                  color: ViraColorVariant.Neutral,
                                  buttonEmphasis: ViraEmphasis.Subtle,
                                  isDisabled: state.isLoadingFamilies,
                              })}
                                  ${listen('click', async () => {
                                      await loadFamilies();
                                  })}
                              ></${ViraButton}>
                          </${VirSettingsRow}>
                      `
                    : nothing}
            </div>
            ${getEnumValues(FontRole)
                .filter((role) => !fontRoleFollows[role] || typography.separateFonts)
                .map(renderRole)}
        `;
    },
});
