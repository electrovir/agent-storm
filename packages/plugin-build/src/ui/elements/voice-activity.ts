import {defineActivity} from '@agent-storm/core/frontend';
import {css, html, listen, nothing} from 'element-vir';
import {
    LucideMicIcon,
    LucideMicOffIcon,
    LucidePhoneIcon,
    LucidePhoneOffIcon,
    ViraButton,
    ViraColorVariant,
    ViraEmphasis,
    ViraSize,
    viraThemeByKeys,
} from 'vira';
import {buildActivityId} from '../../util/build-state.js';
import {
    createVoiceCallState,
    endVoiceCall,
    startVoiceCall,
    toggleVoiceMute,
    VoiceCallStatus,
    VoiceSpeaker,
} from '../../util/voice-call-state.js';

const statusLabels: Readonly<Record<VoiceCallStatus, string>> = {
    [VoiceCallStatus.Idle]: 'Not in a call',
    [VoiceCallStatus.Connecting]: 'Connecting…',
    [VoiceCallStatus.Live]: 'Listening',
};

const speakerLabels: Readonly<Record<VoiceSpeaker, string>> = {
    [VoiceSpeaker.User]: 'You',
    [VoiceSpeaker.Assistant]: 'Voice',
    [VoiceSpeaker.Tool]: 'Action',
};

/**
 * A spoken conversation with OpenAI's realtime model, which controls Build's threads through its
 * own tools. The call keeps going while other activities show.
 */
export const voiceActivity = defineActivity({
    id: 'voice',
    label: 'Voice',
    isEnabledByDefault: true,
    createState: createVoiceCallState,
    mobileMenuTitle: undefined,
    sidebar: undefined,
    isKeptMounted: false,
    render({context, state}) {
        const status = state.status.value;
        const subtleColor = viraThemeByKeys.grey.foreground.placeholder.foreground.value;
        const callButtons =
            status === VoiceCallStatus.Idle
                ? html`
                      <${ViraButton.assign({
                          text: 'Start call',
                          icon: LucidePhoneIcon,
                          color: ViraColorVariant.Positive,
                      })}
                          ${listen('click', async () => {
                              await startVoiceCall({
                                  state,
                                  openThread(threadId) {
                                      context.navigate([
                                          buildActivityId,
                                          threadId,
                                      ]);
                                  },
                              });
                          })}
                      ></${ViraButton}>
                  `
                : html`
                      <${ViraButton.assign({
                          text: state.isMuted.value ? 'Unmute' : 'Mute',
                          icon: state.isMuted.value ? LucideMicOffIcon : LucideMicIcon,
                          color: ViraColorVariant.Neutral,
                          isDisabled: status !== VoiceCallStatus.Live,
                      })}
                          ${listen('click', () => {
                              if (status === VoiceCallStatus.Live) {
                                  toggleVoiceMute(state);
                              }
                          })}
                      ></${ViraButton}>
                      <${ViraButton.assign({
                          text: 'End call',
                          icon: LucidePhoneOffIcon,
                          color: ViraColorVariant.Danger,
                      })}
                          ${listen('click', async () => {
                              await endVoiceCall(state);
                          })}
                      ></${ViraButton}>
                  `;

        const entries = state.transcript.value.toReversed().map((entry) => {
            return html`
                <div
                    style=${css`
                        display: flex;
                        flex-direction: column;
                        gap: 2px;
                        padding: 8px 12px;
                        border-radius: 8px;
                        ${entry.speaker === VoiceSpeaker.Tool
                            ? css`
                                  border: 1px solid ${subtleColor};
                              `
                            : css``}
                        ${entry.isFailed
                            ? css`
                                  color: ${viraThemeByKeys.red.foreground.header.foreground.value};
                              `
                            : css``}
                    `}
                >
                    <span
                        style=${css`
                            color: ${subtleColor};
                            font-size: 0.85em;
                        `}
                    >
                        ${speakerLabels[entry.speaker]}
                    </span>
                    <span
                        style=${css`
                            white-space: pre-wrap;
                        `}
                    >
                        ${entry.text || '…'}
                    </span>
                    ${entry.threadId
                        ? html`
                              <div>
                                  <${ViraButton.assign({
                                      text: 'Open thread',
                                      buttonSize: ViraSize.Small,
                                      buttonEmphasis: ViraEmphasis.Subtle,
                                      color: ViraColorVariant.Neutral,
                                  })}
                                      ${listen('click', () => {
                                          context.navigate([
                                              buildActivityId,
                                              entry.threadId,
                                          ]);
                                      })}
                                  ></${ViraButton}>
                              </div>
                          `
                        : nothing}
                </div>
            `;
        });

        return html`
            <div
                style=${css`
                    display: flex;
                    flex-direction: column;
                    gap: 12px;
                    height: 100%;
                    max-width: 720px;
                    padding: 16px;
                    box-sizing: border-box;
                `}
            >
                <div
                    style=${css`
                        display: flex;
                        align-items: center;
                        flex-wrap: wrap;
                        gap: 8px;
                    `}
                >
                    ${callButtons}
                    <span
                        style=${css`
                            color: ${subtleColor};
                        `}
                    >
                        ${state.isMuted.value ? 'Muted' : statusLabels[status]}
                    </span>
                </div>
                ${state.error.value
                    ? html`
                          <span
                              style=${css`
                                  color: ${viraThemeByKeys.red.foreground.header.foreground.value};
                                  white-space: pre-wrap;
                              `}
                          >
                              ${state.error.value}
                          </span>
                      `
                    : nothing}
                ${entries.length
                    ? html`
                          <div
                              style=${css`
                                  display: flex;
                                  flex-direction: column-reverse;
                                  gap: 8px;
                                  flex-grow: 1;
                                  overflow-y: auto;
                              `}
                          >
                              ${entries}
                          </div>
                      `
                    : html`
                          <span
                              style=${css`
                                  color: ${subtleColor};
                              `}
                          >
                              Talk to Build's threads hands-free: ask what they're doing, send them
                              work, answer their questions, or open one on screen. Wear headphones,
                              so the voice doesn't hear itself.
                          </span>
                      `}
            </div>
        `;
    },
});
