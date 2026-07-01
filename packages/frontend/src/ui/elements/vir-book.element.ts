import {BookMainRoute, defineBookPage, ElementBookApp} from 'element-book';
import {css, defineElement, html, listen} from 'element-vir';
import {lucideIcons, ViraButton, ViraColorVariant, ViraIcon, ViraSize} from 'vira';
import {router} from '../../util/router.js';
import {viraButtonOverrides} from '../button-overrides.styles.js';
import {VirAddRepo} from './vir-add-repo.element.js';

/*
 * element-book renders each example inside its own \`book-element-example-viewer\` shadow DOM,
 * so the host-level \`viraButtonOverrides\` on \`vir-book\` never reach the example \`vira-button\`s.
 * Inline the overrides into the per-example styles so each example's shadow root gets them.
 */
const exampleRowStyles = css`
    :host {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 12px;
    }

    ${viraButtonOverrides}
`;

const buttonsPage = defineBookPage({
    parent: undefined,
    title: 'Buttons',
    descriptionParagraphs: [
        'Every vira-button variation used across agent-storm. Buttons in this app combine three colors (brand, neutral, danger), three sizes (small, medium, large), and three shapes (text-only, icon + text, icon-only).',
    ],
    defineExamples({defineExample}) {
        defineExample({
            title: 'Brand — primary actions',
            descriptionParagraphs: [
                'High-emphasis buttons reserved for the single primary action in a flow (Add repo, Submit, Save changes).',
            ],
            styles: exampleRowStyles,
            render() {
                return html`
                    <${ViraButton.assign({
                        text: 'Add repo',
                        icon: lucideIcons.Plus,
                        buttonSize: ViraSize.Medium,
                        color: ViraColorVariant.Brand,
                    })}></${ViraButton}>
                    <${ViraButton.assign({
                        text: 'Submit',
                        buttonSize: ViraSize.Medium,
                        color: ViraColorVariant.Brand,
                    })}></${ViraButton}>
                    <${ViraButton.assign({
                        text: 'Save changes',
                        buttonSize: ViraSize.Medium,
                        color: ViraColorVariant.Brand,
                    })}></${ViraButton}>
                `;
            },
        });
        defineExample({
            title: 'Neutral — secondary actions',
            descriptionParagraphs: [
                'Lower-emphasis buttons used for cancel actions and non-primary navigation like opening the element book.',
            ],
            styles: exampleRowStyles,
            render() {
                return html`
                    <${ViraButton.assign({
                        text: 'Cancel',
                        buttonSize: ViraSize.Medium,
                        color: ViraColorVariant.Neutral,
                    })}></${ViraButton}>
                    <${ViraButton.assign({
                        text: 'See element book',
                        icon: lucideIcons.BookOpen,
                        buttonSize: ViraSize.Medium,
                        color: ViraColorVariant.Neutral,
                    })}></${ViraButton}>
                `;
            },
        });
        defineExample({
            title: 'Danger — destructive actions',
            descriptionParagraphs: [
                'Buttons for actions that are hard to undo or carry risk, like restarting the daemon or removing a repo.',
            ],
            styles: exampleRowStyles,
            render() {
                return html`
                    <${ViraButton.assign({
                        text: 'Restart daemon',
                        icon: lucideIcons.RotateCw,
                        buttonSize: ViraSize.Medium,
                        color: ViraColorVariant.Danger,
                    })}></${ViraButton}>
                    <${ViraButton.assign({
                        text: 'Remove',
                        icon: lucideIcons.X,
                        buttonSize: ViraSize.Medium,
                        color: ViraColorVariant.Danger,
                    })}></${ViraButton}>
                `;
            },
        });
        defineExample({
            title: 'Icon-only — neutral',
            descriptionParagraphs: [
                'Compact controls for toolbars, row actions, and menu triggers. Always pair with a `title` attribute for accessibility.',
            ],
            styles: exampleRowStyles,
            render() {
                return html`
                    <${ViraButton.assign({
                        icon: lucideIcons.Settings,
                        buttonSize: ViraSize.Small,
                        color: ViraColorVariant.Neutral,
                    })}></${ViraButton}>
                    <${ViraButton.assign({
                        icon: lucideIcons.GitBranchPlus,
                        buttonSize: ViraSize.Small,
                        color: ViraColorVariant.Neutral,
                    })}></${ViraButton}>
                    <${ViraButton.assign({
                        icon: lucideIcons.EllipsisVertical,
                        buttonSize: ViraSize.Small,
                        color: ViraColorVariant.Neutral,
                    })}></${ViraButton}>
                    <${ViraButton.assign({
                        icon: lucideIcons.EyeOff,
                        buttonSize: ViraSize.Small,
                        color: ViraColorVariant.Neutral,
                    })}></${ViraButton}>
                `;
            },
        });
        defineExample({
            title: 'Icon-only — danger',
            descriptionParagraphs: [
                'Used for row-level destructive actions like removing a repo from the sidebar or clearing a hidden-path entry.',
            ],
            styles: exampleRowStyles,
            render() {
                return html`
                    <${ViraButton.assign({
                        icon: lucideIcons.X,
                        buttonSize: ViraSize.Small,
                        color: ViraColorVariant.Danger,
                    })}></${ViraButton}>
                `;
            },
        });
        defineExample({
            title: 'Sizes',
            descriptionParagraphs: [
                'Small (28px) is used for icon-only toolbar controls. Medium (32px) is the default for form and modal buttons. Large (40px) is reserved for hero CTAs.',
            ],
            styles: exampleRowStyles,
            render() {
                return html`
                    <${ViraButton.assign({
                        text: 'Small',
                        icon: lucideIcons.Plus,
                        buttonSize: ViraSize.Small,
                        color: ViraColorVariant.Brand,
                    })}></${ViraButton}>
                    <${ViraButton.assign({
                        text: 'Medium',
                        icon: lucideIcons.Plus,
                        buttonSize: ViraSize.Medium,
                        color: ViraColorVariant.Brand,
                    })}></${ViraButton}>
                    <${ViraButton.assign({
                        text: 'Large',
                        icon: lucideIcons.Plus,
                        buttonSize: ViraSize.Large,
                        color: ViraColorVariant.Brand,
                    })}></${ViraButton}>
                `;
            },
        });
        defineExample({
            title: 'Icon-only sizes',
            descriptionParagraphs: [
                'Icon-only buttons stay square at every size (28 / 32 / 40 px).',
            ],
            styles: exampleRowStyles,
            render() {
                return html`
                    <${ViraButton.assign({
                        icon: lucideIcons.Settings,
                        buttonSize: ViraSize.Small,
                        color: ViraColorVariant.Neutral,
                    })}></${ViraButton}>
                    <${ViraButton.assign({
                        icon: lucideIcons.Settings,
                        buttonSize: ViraSize.Medium,
                        color: ViraColorVariant.Neutral,
                    })}></${ViraButton}>
                    <${ViraButton.assign({
                        icon: lucideIcons.Settings,
                        buttonSize: ViraSize.Large,
                        color: ViraColorVariant.Neutral,
                    })}></${ViraButton}>
                `;
            },
        });
        defineExample({
            title: 'Disabled state',
            descriptionParagraphs: [
                'Disabled buttons drop to 50% opacity and switch to a not-allowed cursor. Used while a save or restart is in flight, or before required fields are filled in.',
            ],
            styles: exampleRowStyles,
            render() {
                return html`
                    <${ViraButton.assign({
                        text: 'Saving…',
                        buttonSize: ViraSize.Medium,
                        color: ViraColorVariant.Brand,
                        isDisabled: true,
                    })}></${ViraButton}>
                    <${ViraButton.assign({
                        text: 'Cancel',
                        buttonSize: ViraSize.Medium,
                        color: ViraColorVariant.Neutral,
                        isDisabled: true,
                    })}></${ViraButton}>
                    <${ViraButton.assign({
                        text: 'Restarting…',
                        icon: lucideIcons.RotateCw,
                        buttonSize: ViraSize.Medium,
                        color: ViraColorVariant.Danger,
                        isDisabled: true,
                    })}></${ViraButton}>
                    <${ViraButton.assign({
                        icon: lucideIcons.X,
                        buttonSize: ViraSize.Small,
                        color: ViraColorVariant.Danger,
                        isDisabled: true,
                    })}></${ViraButton}>
                `;
            },
        });
        defineExample({
            title: 'Emphasis — primary / secondary / tertiary',
            descriptionParagraphs: [
                'App-level emphasis classes layered on top of `ViraColorVariant.Custom`. Defined in button-overrides.styles.ts so every vira-button in the app can pick a single class instead of re-deriving accent colors per call site.',
            ],
            styles: exampleRowStyles,
            render() {
                return html`
                    <${ViraButton.assign({
                        text: 'Primary',
                        buttonSize: ViraSize.Medium,
                        color: ViraColorVariant.Custom,
                    })}
                        class="primary"
                    ></${ViraButton}>
                    <${ViraButton.assign({
                        text: 'Secondary',
                        buttonSize: ViraSize.Medium,
                        color: ViraColorVariant.Custom,
                    })}
                        class="secondary"
                    ></${ViraButton}>
                    <${ViraButton.assign({
                        text: 'add repository',
                        icon: lucideIcons.Plus,
                        buttonSize: ViraSize.Medium,
                        color: ViraColorVariant.Custom,
                    })}
                        class="tertiary"
                    ></${ViraButton}>
                `;
            },
        });
        defineExample({
            title: 'Sidebar — new worktree',
            descriptionParagraphs: [
                'Solid copper-outline call-to-action at the top of the sidebar that opens the new-worktree menu. Uses ViraColorVariant.Custom with a sidebar-local class that overrides the vira-button CSS vars.',
            ],
            styles: css`
                :host {
                    display: block;
                    padding: 16px;
                    background: var(--sidebar-bg);
                    border-radius: var(--radius-panel-md);
                    border: 1px solid var(--sidebar-border);
                    width: 280px;
                    box-sizing: border-box;
                }

                vira-button.new-worktree {
                    width: 100%;
                    text-transform: uppercase;
                    letter-spacing: 0.12em;
                    font-size: 11px;
                    --vira-button-background-color: color-mix(in srgb, var(--copper) 6%, transparent);
                    --vira-button-text-color: var(--copper);
                    --vira-button-border-color: var(--copper);
                    --vira-button-hover-background-color: color-mix(in srgb, var(--copper) 14%, transparent);
                    --vira-button-hover-text-color: var(--copper);
                    --vira-button-hover-border-color: var(--copper);
                    --vira-button-active-background-color: color-mix(in srgb, var(--copper) 14%, transparent);
                    --vira-button-active-text-color: var(--copper);
                    --vira-button-active-border-color: var(--copper);
                }
            `,
            render() {
                return html`
                    <${ViraButton.assign({
                        text: 'New worktree',
                        icon: lucideIcons.GitBranchPlus,
                        buttonSize: ViraSize.Medium,
                        color: ViraColorVariant.Custom,
                    })}
                        class="new-worktree"
                    ></${ViraButton}>
                `;
            },
        });
        defineExample({
            title: 'Sidebar — ghost icon',
            descriptionParagraphs: [
                'Transparent icon-only buttons used in the sidebar footer (settings gear) and on each repo row (ellipsis menu trigger). Uses ViraColorVariant.Custom with a sidebar-local class that pins the colors to sidebar tokens.',
            ],
            styles: css`
                :host {
                    display: flex;
                    gap: 12px;
                    padding: 16px;
                    background: var(--sidebar-bg);
                    border-radius: var(--radius-panel-md);
                    border: 1px solid var(--sidebar-border);
                }

                vira-button.ghost-icon {
                    --vira-button-background-color: transparent;
                    --vira-button-text-color: var(--sidebar-fg-subtle);
                    --vira-button-border-color: transparent;
                    --vira-button-hover-background-color: var(--sidebar-accent-bg-hover);
                    --vira-button-hover-text-color: var(--sidebar-fg);
                    --vira-button-hover-border-color: transparent;
                    --vira-button-active-background-color: var(--sidebar-accent-bg-hover);
                    --vira-button-active-text-color: var(--sidebar-fg);
                    --vira-button-active-border-color: transparent;
                }
            `,
            render() {
                return html`
                    <${ViraButton.assign({
                        icon: lucideIcons.Settings,
                        buttonSize: ViraSize.Medium,
                        color: ViraColorVariant.Custom,
                    })}
                        class="ghost-icon"
                        title="Settings"
                    ></${ViraButton}>
                    <${ViraButton.assign({
                        icon: lucideIcons.EllipsisVertical,
                        buttonSize: ViraSize.Medium,
                        color: ViraColorVariant.Custom,
                    })}
                        class="ghost-icon"
                        title="Folder actions"
                    ></${ViraButton}>
                `;
            },
        });
        defineExample({
            title: 'Segmented — theme picker',
            descriptionParagraphs: [
                "The radio-style segmented buttons in the settings modal's appearance section (icon stacked above label, accent-tinted active state). Lives in vir-appearance-section as a raw <button> with role=radio because vira-button's shadow DOM lays out the icon and label horizontally and can't be flipped to a vertical stack.",
            ],
            styles: css`
                :host {
                    display: block;
                    width: 360px;
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
            render() {
                return html`
                    <div class="theme-picker" role="radiogroup" aria-label="Theme">
                        <button class="theme-option" type="button" role="radio" aria-checked="false">
                            <${ViraIcon.assign({icon: lucideIcons.Monitor})}></${ViraIcon}>
                            <span>Follow system</span>
                        </button>
                        <button
                            class="theme-option active"
                            type="button"
                            role="radio"
                            aria-checked="true"
                        >
                            <${ViraIcon.assign({icon: lucideIcons.Moon})}></${ViraIcon}>
                            <span>Dark</span>
                        </button>
                        <button class="theme-option" type="button" role="radio" aria-checked="false">
                            <${ViraIcon.assign({icon: lucideIcons.Sun})}></${ViraIcon}>
                            <span>Light</span>
                        </button>
                    </div>
                `;
            },
        });
    },
});

const addRepoPage = defineBookPage({
    parent: undefined,
    title: 'Add Repo',
    descriptionParagraphs: ['The empty-state screen shown when no repos are configured.'],
    defineExamples({defineExample}) {
        defineExample({
            title: 'Default state',
            render() {
                return html`
                    <${VirAddRepo}></${VirAddRepo}>
                `;
            },
        });
    },
});

export const VirBook = defineElement<{
    subPaths: ReadonlyArray<string>;
}>()({
    tagName: 'vir-book',
    styles: css`
        :host {
            display: block;
            width: 100%;
            height: 100%;
            background: var(--bg);
            color: var(--fg);
        }

        element-book-app {
            width: 100%;
            height: 100%;
        }

        ${viraButtonOverrides}
    `,
    render({inputs}) {
        return html`
            <${ElementBookApp.assign({
                pages: [
                    buttonsPage,
                    addRepoPage,
                ],
                elementBookRoutePaths: [
                    BookMainRoute.Book,
                    ...inputs.subPaths,
                ],
            })}
                ${listen(ElementBookApp.events.pathUpdate, (event) => {
                    const newPaths = event.detail;
                    router.setRoute({
                        paths: [
                            'book',
                            ...newPaths.slice(1),
                        ] as [
                            'book',
                            ...string[],
                        ],
                    });
                })}
            ></${ElementBookApp}>
        `;
    },
});
