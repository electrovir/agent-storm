import {UserThemeSelection} from '@agent-storm/common';
import {css, defineElement, defineElementEvent, html, listen} from 'element-vir';
import {lucideIcons, ViraIcon} from 'vira';

const themeOptions: ReadonlyArray<{
    value: UserThemeSelection;
    label: string;
    icon: typeof lucideIcons.Sun;
}> = [
    {
        value: UserThemeSelection.Auto,
        label: 'Follow system',
        icon: lucideIcons.Monitor,
    },
    {
        value: UserThemeSelection.Dark,
        label: 'Dark',
        icon: lucideIcons.Moon,
    },
    {
        value: UserThemeSelection.Light,
        label: 'Light',
        icon: lucideIcons.Sun,
    },
];

export const VirAppearanceSection = defineElement<{
    theme: UserThemeSelection;
}>()({
    tagName: 'vir-appearance-section',
    events: {
        themeChange: defineElementEvent<UserThemeSelection>(),
    },
    styles: css`
        :host {
            display: block;
        }

        .section {
            display: flex;
            flex-direction: column;
            gap: 16px;
            padding: 18px 20px;
            border: 1px solid var(--border-subtle);
            border-radius: var(--radius-panel-md);
            background: var(--bg-muted);
            font-family: var(--font-body);
            color: var(--fg);
        }

        .section-header {
            display: flex;
            flex-direction: column;
            gap: 4px;
        }

        .section-title {
            font-size: var(--font-size-md);
            font-weight: var(--font-weight-semibold);
            color: var(--fg-emphasized);
            letter-spacing: -0.005em;
        }

        .section-subtitle {
            font-size: var(--font-size-xs);
            line-height: var(--line-height-xs);
            color: var(--fg-muted);
        }

        .theme-picker {
            display: flex;
            gap: 8px;
        }

        .theme-option {
            flex: 1;
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 6px;
            padding: 12px 8px;
            border: 1px solid var(--border-subtle);
            background: var(--bg-emphasized);
            color: var(--fg-subtle);
            border-radius: var(--radius-control-md);
            font-family: var(--font-body);
            font-size: var(--font-size-xs);
            font-weight: var(--font-weight-medium);
            cursor: pointer;
            transition:
                background-color 120ms ease,
                color 120ms ease,
                border-color 120ms ease;
        }

        .theme-option:hover {
            background: color-mix(in srgb, var(--bg-emphasized) 60%, var(--accent-solid));
            color: var(--fg);
        }

        .theme-option.active {
            border-color: var(--accent-solid);
            background: color-mix(in srgb, var(--accent-solid) 18%, var(--bg-emphasized));
            color: var(--fg);
        }

        .theme-option vira-icon {
            display: block;
        }
    `,
    render({inputs, dispatch, events}) {
        return html`
            <section class="section">
                <div class="section-header">
                    <span class="section-title">Appearance</span>
                    <span class="section-subtitle">
                        Choose how agent-storm looks. "Follow system" tracks your OS dark-mode
                        preference.
                    </span>
                </div>
                <div class="theme-picker" role="radiogroup" aria-label="Theme">
                    ${themeOptions.map(
                        (option) => html`
                            <button
                                type="button"
                                role="radio"
                                aria-checked=${inputs.theme === option.value}
                                class="theme-option ${inputs.theme === option.value
                                    ? 'active'
                                    : ''}"
                                ${listen('click', () =>
                                    dispatch(new events.themeChange(option.value)),
                                )}
                            >
                                <${ViraIcon.assign({
                                    icon: option.icon,
                                })}></${ViraIcon}>
                                <span>${option.label}</span>
                            </button>
                        `,
                    )}
                </div>
            </section>
        `;
    },
});
