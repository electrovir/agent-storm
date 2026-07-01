import {css} from 'element-vir';

/**
 * Shared visual polish applied to every `vira-button` inside an element. Tweaks the cross
 * shadow-DOM CSS vars vira exposes so each call site keeps using `ViraButton.assign(...)`
 * exactly as before. Mirrors the surface-button styling of a modern SaaS dashboard:
 * subtle elevation, medium font weight, control-sized corner radius, and a font that
 * matches the rest of the app shell.
 */
export const viraButtonOverrides = css`
    vira-button {
        --vira-button-border-radius: var(--radius-control-md);
        font-family: var(--font-body);
        font-weight: var(--font-weight-medium);
        font-size: var(--font-size-sm);
        letter-spacing: -0.005em;
        line-height: 1.2;
        transition:
            background-color 120ms ease,
            color 120ms ease,
            border-color 120ms ease,
            box-shadow 120ms ease,
            opacity 120ms ease;
    }

    /*
     * Vira's default neutral palette derives both bg and fg from the page background, so in
     * a white app shell a neutral button renders white-on-white-with-a-faint-border. We pin
     * neutral/plain buttons to our semantic surface tokens so they read on either theme.
     */
    vira-button.vira-button-color-neutral.vira-button-emphasis-standard,
    vira-button.vira-button-color-plain.vira-button-emphasis-standard {
        --vira-button-background-color: var(--bg-emphasized);
        --vira-button-text-color: var(--fg);
        --vira-button-border-color: var(--border-emphasized);
        --vira-button-hover-background-color: var(--bg-subtle);
        --vira-button-hover-text-color: var(--fg-emphasized);
        --vira-button-hover-border-color: var(--border-emphasized);
        --vira-button-active-background-color: var(--bg-emphasized);
        --vira-button-active-text-color: var(--fg-emphasized);
        --vira-button-active-border-color: var(--border-emphasized);
    }

    vira-button.vira-button-color-neutral.vira-button-emphasis-subtle,
    vira-button.vira-button-color-plain.vira-button-emphasis-subtle {
        --vira-button-background-color: transparent;
        --vira-button-text-color: var(--fg-muted);
        --vira-button-border-color: transparent;
        --vira-button-hover-background-color: var(--bg-subtle);
        --vira-button-hover-text-color: var(--fg);
        --vira-button-hover-border-color: transparent;
        --vira-button-active-background-color: var(--bg-emphasized);
        --vira-button-active-text-color: var(--fg-emphasized);
        --vira-button-active-border-color: transparent;
    }

    vira-button.vira-button-size-small {
        min-height: 28px;
    }
    vira-button.vira-button-size-small:not(.vira-button-icon-only) {
        min-width: 64px;
    }
    vira-button.vira-button-size-small.vira-button-icon-only {
        min-width: 28px;
    }

    vira-button.vira-button-size-medium {
        min-height: 32px;
    }
    vira-button.vira-button-size-medium:not(.vira-button-icon-only) {
        min-width: 80px;
    }
    vira-button.vira-button-size-medium.vira-button-icon-only {
        min-width: 32px;
    }

    vira-button.vira-button-size-large {
        min-height: 40px;
    }
    vira-button.vira-button-size-large:not(.vira-button-icon-only) {
        min-width: 100px;
    }
    vira-button.vira-button-size-large.vira-button-icon-only {
        min-width: 40px;
    }

    vira-button.vira-button-icon-only {
        --vira-button-border-radius: var(--radius-control-md);
    }

    vira-button.vira-button-disabled {
        opacity: 0.5;
        cursor: not-allowed;
    }

    /*
     * App-level emphasis classes. Apply alongside \`color: ViraColorVariant.Custom\` so vira
     * stops emitting its own variant rules and these vars are the sole source of color truth.
     *
     *   primary    — solid accent fill for the single primary CTA in a flow.
     *   secondary  — neutral outlined surface for confirm/cancel/reset peers.
     *   tertiary   — dashed-outline ghost for low-emphasis add/discover actions.
     *                The dashed border lives on the host because vira hard-codes
     *                \`border-style: solid\` on the inner <button> with no escape hatch.
     */
    vira-button.primary {
        --vira-button-text-color: var(--accent-contrast);
        --vira-button-background-color: var(--accent-solid);
        --vira-button-border-color: var(--accent-solid);
        --vira-button-hover-text-color: var(--accent-contrast);
        --vira-button-hover-background-color: var(--accent-solid-hover);
        --vira-button-hover-border-color: var(--accent-solid-hover);
        --vira-button-active-text-color: var(--accent-contrast);
        --vira-button-active-background-color: var(--accent-solid-hover);
        --vira-button-active-border-color: var(--accent-solid-hover);
    }

    vira-button.secondary {
        --vira-button-text-color: var(--fg);
        --vira-button-background-color: var(--bg-panel);
        --vira-button-border-color: var(--border-emphasized);
        --vira-button-hover-text-color: var(--fg);
        --vira-button-hover-background-color: var(--bg-subtle);
        --vira-button-hover-border-color: var(--border-emphasized);
        --vira-button-active-text-color: var(--fg);
        --vira-button-active-background-color: var(--bg-emphasized);
        --vira-button-active-border-color: var(--border-emphasized);
    }

    vira-button.tertiary {
        --vira-button-text-color: var(--fg-subtle);
        --vira-button-background-color: transparent;
        --vira-button-border-color: transparent;
        --vira-button-hover-text-color: var(--copper);
        --vira-button-hover-background-color: color-mix(in srgb, var(--copper) 4%, transparent);
        --vira-button-hover-border-color: transparent;
        --vira-button-active-text-color: var(--copper);
        --vira-button-active-background-color: color-mix(in srgb, var(--copper) 8%, transparent);
        --vira-button-active-border-color: transparent;

        text-transform: uppercase;
        letter-spacing: 0.1em;
        font-size: var(--font-size-2xs);
    }
`;
