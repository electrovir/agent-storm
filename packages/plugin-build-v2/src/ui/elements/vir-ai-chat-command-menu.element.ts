// cspell:words listbox
import {defineAppElement} from '@agent-storm/core/frontend';
import {classMap, css, defineElementEvent, html, listen} from 'element-vir';
import {
    ViraEmphasis,
    ViraSize,
    ViraTag,
    ViraThemeColorName,
    viraShadows,
    viraThemeByKeys,
} from 'vira';
import {
    ComposerCommandKind,
    ComposerCommandSource,
    type ComposerCommand,
} from '../../build-v2-api.js';
import {composerCommandSigns, describeComposerCommandOrigin} from '../../util/composer-commands.js';

/** The color of a command's origin tag, also used to highlight the command in the message box. */
export const sourceTagColors: Readonly<Record<ComposerCommandSource, ViraThemeColorName>> = {
    [ComposerCommandSource.BuiltIn]: ViraThemeColorName.grey,
    [ComposerCommandSource.Repo]: ViraThemeColorName.blue,
    [ComposerCommandSource.Personal]: ViraThemeColorName.green,
    [ComposerCommandSource.Synced]: ViraThemeColorName.teal,
    [ComposerCommandSource.Plugin]: ViraThemeColorName.purple,
    [ComposerCommandSource.Other]: ViraThemeColorName.tan,
};

/** The background behind a command's name where a message mentions it. */
export function findCommandMentionColor(command: Readonly<ComposerCommand>) {
    return viraThemeByKeys[sourceTagColors[command.source]]['on-self'].body.background.value;
}

/**
 * The commands and skills matching the word typed at the composer's caret, shown above the
 * composer. The composer owns the keyboard, so this only shows `activeIndex` and reports clicks.
 */
export const VirAiChatCommandMenu = defineAppElement<{
    /** Unset while the provider's commands load. */
    commands: ReadonlyArray<Readonly<ComposerCommand>> | undefined;
    /** Which word opened the menu. */
    triggerKind: ComposerCommandKind;
    activeIndex: number;
}>()({
    tagName: 'vir-ai-chat-command-menu',
    events: {
        commandPicked: defineElementEvent<Readonly<ComposerCommand>>(),
        /** The hovered command's index. */
        commandHovered: defineElementEvent<number>(),
    },
    styles: css`
        :host {
            display: block;
            box-sizing: border-box;
            max-height: 288px;
            overflow-y: auto;
            padding: 4px;
            border-radius: 12px;
            border: 1px solid ${viraThemeByKeys.grey.foreground.decoration.foreground.value};
            background-color: ${viraThemeByKeys.grey['behind-bg'].body.foreground.value};
            color: ${viraThemeByKeys.grey.foreground.body.foreground.value};
            font-size: 13px;
            ${viraShadows.menuShadow}
        }

        .command {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 6px 8px;
            border-radius: 8px;
            cursor: pointer;

            &.active {
                background-color: ${viraThemeByKeys.grey['behind-fg']['small-body'].background
                    .value};
            }

            & .name {
                flex-shrink: 0;
                font-weight: 500;
            }

            & .description {
                flex-grow: 1;
                min-width: 0;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
                color: ${viraThemeByKeys.grey.foreground['non-body'].foreground.value};
            }

            & ${ViraTag} {
                flex-shrink: 0;
            }
        }

        .empty {
            padding: 6px 8px;
            color: ${viraThemeByKeys.grey.foreground.placeholder.foreground.value};
        }
    `,
    render({inputs, dispatch, events, host}) {
        /** This render is what moves `.active`, so the row to scroll to exists only after it. */
        requestAnimationFrame(() => {
            host.shadowRoot.querySelector('.active')?.scrollIntoView({
                block: 'nearest',
            });
        });

        if (!inputs.commands?.length) {
            return html`
                <div class="empty">
                    ${inputs.commands
                        ? inputs.triggerKind === ComposerCommandKind.Skill
                            ? 'No skills found. Try / to browse commands.'
                            : 'No matching command.'
                        : 'Searching commands and skills…'}
                </div>
            `;
        }

        return html`
            <div role="listbox" aria-label="Commands and skills">
                ${inputs.commands.map((command, index) => {
                    return html`
                        <div
                            class=${classMap({
                                command: true,
                                active: index === inputs.activeIndex,
                            })}
                            role="option"
                            aria-selected=${index === inputs.activeIndex}
                            ${listen('mousemove', () => {
                                if (index !== inputs.activeIndex) {
                                    dispatch(
                                        new events.commandHovered({
                                            detail: index,
                                        }),
                                    );
                                }
                            })}
                            ${listen('click', () => {
                                dispatch(
                                    new events.commandPicked({
                                        detail: command,
                                    }),
                                );
                            })}
                        >
                            <span class="name">
                                ${composerCommandSigns[command.kind]}${command.name}
                            </span>
                            <span class="description">${command.description}</span>
                            <${ViraTag.assign({
                                text: describeComposerCommandOrigin(command),
                                size: ViraSize.Small,
                                color: sourceTagColors[command.source],
                                emphasis: ViraEmphasis.Subtle,
                            })}></${ViraTag}>
                        </div>
                    `;
                })}
            </div>
        `;
    },
});
