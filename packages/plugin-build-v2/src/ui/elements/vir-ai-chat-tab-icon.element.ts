import {defineAppElement, spinAnimationCss, spinKeyframesCss} from '@agent-storm/core/frontend';
import {css, html, type Observable} from 'element-vir';
import {createSizedIcon, LucideLoaderIcon, ViraIcon, viraThemeByKeys, type ViraIconSvg} from 'vira';
import {type Thread} from '../../build-v2-api.js';
import {isThreadWorking} from './thread-display.js';

const workingIcon = createSizedIcon(LucideLoaderIcon, 14);

/** An AI Chat tab's icon: its thread's spinner or new-reply dot, else `icon`. */
export const VirAiChatTabIcon = defineAppElement<{
    threads: Readonly<Observable<ReadonlyArray<Readonly<Thread>> | undefined>>;
    sideChats: Readonly<Observable<ReadonlyArray<Readonly<Thread>>>>;
    threadId: string;
    icon: ViraIconSvg;
}>()({
    tagName: 'vir-ai-chat-tab-icon',
    styles: css`
        :host {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 14px;
            height: 14px;
        }

        .working {
            color: ${viraThemeByKeys.pink.foreground.header.foreground.value};
            ${spinAnimationCss}
        }

        .unread-dot {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background-color: ${viraThemeByKeys.blue.foreground.body.foreground.value};
        }

        ${spinKeyframesCss}
    `,
    render({inputs}) {
        const thread = [
            ...(inputs.threads.value || []),
            ...inputs.sideChats.value,
        ].find((entry) => entry.id === inputs.threadId);

        if (thread && isThreadWorking(thread)) {
            return html`
                <${ViraIcon.assign({
                    icon: workingIcon,
                })}
                    class="working"
                ></${ViraIcon}>
            `;
        } else if (thread?.hasUnreadReply) {
            return html`
                <span class="unread-dot" role="img" aria-label="New reply"></span>
            `;
        } else {
            return html`
                <${ViraIcon.assign({
                    icon: inputs.icon,
                })}></${ViraIcon}>
            `;
        }
    },
});
