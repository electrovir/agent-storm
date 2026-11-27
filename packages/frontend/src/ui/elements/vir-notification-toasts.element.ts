import {type AppNotification, type NotificationType} from '@agent-storm/common';
import {defineAppElement} from '@agent-storm/core/frontend';
import {css, defineElementEvent, html, listen, nothing} from 'element-vir';
import {
    LucideXIcon,
    ViraButton,
    ViraColorVariant,
    ViraEmphasis,
    ViraSize,
    viraThemeByKeys,
} from 'vira';

/** Code spans, then `**bold**`, then `*italic*`. Underscores are left alone to spare snake_case. */
const inlineMarkdownPattern = /`([^`]+)`|\*\*(.+?)\*\*|\*(?!\s)([^*]+?)(?<!\s)\*/g;

/**
 * Renders the inline markdown a plugin may put in a notification's text: code spans, bold, and
 * italics. Built from lit templates rather than HTML, so the text stays escaped.
 */
function renderInlineMarkdown(text: string) {
    const matches = [...text.matchAll(inlineMarkdownPattern)];
    const matchEnds = matches.map((match) => match.index + match[0].length);
    return [
        ...matches.flatMap((match, matchIndex) => {
            const [
                ,
                code,
                bold,
                italic,
            ] = match;
            return [
                text.slice(matchEnds[matchIndex - 1] ?? 0, match.index),
                code == undefined
                    ? bold == undefined
                        ? html`
                              <em>${italic}</em>
                          `
                        : html`
                              <strong>${bold}</strong>
                          `
                    : html`
                          <code>${code}</code>
                      `,
            ];
        }),
        text.slice(matchEnds.at(-1) ?? 0),
    ];
}

/** The app's notifications, stacked in a corner. A click on one opens its route. */
export const VirNotificationToasts = defineAppElement<{
    notifications: ReadonlyArray<AppNotification>;
    notificationTypes: ReadonlyArray<NotificationType>;
}>()({
    tagName: 'vir-notification-toasts',
    events: {
        open: defineElementEvent<AppNotification>(),
        dismiss: defineElementEvent<string>(),
    },
    styles: css`
        :host {
            position: fixed;
            right: 16px;
            bottom: 16px;
            z-index: 1000;
            display: flex;
            flex-direction: column;
            gap: 8px;
            max-width: min(360px, calc(100vw - 32px));
            pointer-events: none;
        }

        .toast {
            display: flex;
            align-items: flex-start;
            gap: 8px;
            padding: 10px 8px 10px 14px;
            border: 1px solid ${viraThemeByKeys.grey['behind-bg'].decoration.background.value};
            border-radius: 8px;
            background: ${viraThemeByKeys.grey['behind-fg']['small-body'].background.value};
            box-shadow: 0 4px 16px rgba(0, 0, 0, 0.25);
            cursor: pointer;
            pointer-events: auto;
        }

        .text {
            display: flex;
            flex-direction: column;
            flex-grow: 1;
            gap: 2px;
            min-width: 0;
            overflow-wrap: anywhere;

            & code {
                padding: 0 3px;
                border: 1px solid ${viraThemeByKeys.grey.foreground.decoration.foreground.value};
                border-radius: 3px;
                font-family: monospace;
                font-size: 0.85em;
            }
        }

        .type,
        .body {
            font-size: 12px;
            color: ${viraThemeByKeys.grey.foreground['non-body'].foreground.value};
        }

        .title {
            font-weight: 600;
        }
    `,
    render({inputs, dispatch, events}) {
        return inputs.notifications.map((notification) => {
            const typeLabel = inputs.notificationTypes.find((type) => {
                return type.id === notification.typeId;
            })?.label;
            return html`
                <div
                    class="toast"
                    ${listen('click', () => {
                        dispatch(
                            new events.open({
                                detail: notification,
                            }),
                        );
                    })}
                >
                    <div class="text">
                        ${typeLabel
                            ? html`
                                  <span class="type">${typeLabel}</span>
                              `
                            : nothing}
                        <span class="title">${renderInlineMarkdown(notification.title)}</span>
                        <span class="body">${renderInlineMarkdown(notification.body)}</span>
                    </div>
                    <${ViraButton.assign({
                        icon: LucideXIcon,
                        buttonSize: ViraSize.Small,
                        buttonEmphasis: ViraEmphasis.Subtle,
                        color: ViraColorVariant.Neutral,
                    })}
                        ${listen('click', (event) => {
                            event.stopPropagation();
                            dispatch(
                                new events.dismiss({
                                    detail: notification.id,
                                }),
                            );
                        })}
                    ></${ViraButton}>
                </div>
            `;
        });
    },
});
