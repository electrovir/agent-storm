import {createCuid2, extractErrorMessage} from '@augment-vir/common';
import {Observable} from 'element-vir';
import {checkWrapValidShape, defineShape, optionalShape, unknownShape} from 'object-shape-tester';
import {buildClient} from './build-client.js';

export enum VoiceCallStatus {
    Idle = 'idle',
    Connecting = 'connecting',
    Live = 'live',
}

export enum VoiceSpeaker {
    User = 'user',
    Assistant = 'assistant',
    /** One of the voice model's tool runs. */
    Tool = 'tool',
}

export type VoiceTranscriptEntry = Readonly<{
    /** The realtime item's id for speech, a generated one for a tool run. */
    id: string;
    speaker: VoiceSpeaker;
    text: string;
    /** The thread a tool run acted on. Empty for none. */
    threadId: string;
    isFailed: boolean;
}>;

/** The browser's side of a live call. */
type ConnectedCall = Readonly<{
    callId: string;
    peerConnection: RTCPeerConnection;
    microphone: MediaStream;
    audio: HTMLAudioElement;
    removeListeners(): Promise<void>;
}>;

/** A voice call, kept per window so it keeps talking while other activities show. */
export function createVoiceCallState() {
    return {
        status: new Observable<VoiceCallStatus>({
            defaultValue: VoiceCallStatus.Idle,
        }),
        isMuted: new Observable<boolean>({
            defaultValue: false,
        }),
        /** The current or last call's speech and tool runs, oldest first. */
        transcript: new Observable<ReadonlyArray<VoiceTranscriptEntry>>({
            defaultValue: [],
        }),
        error: new Observable<string | undefined>({
            defaultValue: undefined,
        }),
        call: new Observable<ConnectedCall | undefined>({
            defaultValue: undefined,
        }),
        /** Set while a call connects. Ending the call clears it, which cancels that start. */
        startId: new Observable<string | undefined>({
            defaultValue: undefined,
        }),
    };
}

export type VoiceCallState = ReturnType<typeof createVoiceCallState>;

/** Applies `update` to the entry with `id`, adding the entry at the end when there's none. */
function upsertEntry({
    state,
    id,
    speaker,
    update,
}: Readonly<{
    state: Readonly<VoiceCallState>;
    id: string;
    speaker: VoiceSpeaker;
    update(text: string): string;
}>) {
    const transcript = state.transcript.value;
    state.transcript.setValue(
        transcript.some((entry) => entry.id === id)
            ? transcript.map((entry) => {
                  return entry.id === id
                      ? {
                            ...entry,
                            text: update(entry.text),
                        }
                      : entry;
              })
            : [
                  ...transcript,
                  {
                      id,
                      speaker,
                      text: update(''),
                      threadId: '',
                      isFailed: false,
                  },
              ],
    );
}

const channelEventShape = defineShape({
    type: '',
    item_id: optionalShape('', {
        alsoUndefined: true,
    }),
    delta: optionalShape('', {
        alsoUndefined: true,
    }),
    transcript: optionalShape('', {
        alsoUndefined: true,
    }),
    error: optionalShape(unknownShape(), {
        alsoUndefined: true,
    }),
});

type ChannelEvent = typeof channelEventShape.runtimeType;

/** What the transcript does with each realtime event it shows, keyed by the event's type. */
const channelEventHandlers: Readonly<
    Record<
        string,
        (params: Readonly<{state: Readonly<VoiceCallState>; event: ChannelEvent}>) => void
    >
> = {
    /** Holds the user's place in order, since their transcription arrives after the reply starts. */
    'input_audio_buffer.committed'({state, event}) {
        upsertEntry({
            state,
            id: event.item_id || createCuid2(),
            speaker: VoiceSpeaker.User,
            update(text) {
                return text;
            },
        });
    },
    'conversation.item.input_audio_transcription.delta'({state, event}) {
        upsertEntry({
            state,
            id: event.item_id || createCuid2(),
            speaker: VoiceSpeaker.User,
            update(text) {
                return text + (event.delta || '');
            },
        });
    },
    'conversation.item.input_audio_transcription.completed'({state, event}) {
        upsertEntry({
            state,
            id: event.item_id || createCuid2(),
            speaker: VoiceSpeaker.User,
            update(text) {
                return event.transcript || text;
            },
        });
    },
    'response.output_audio_transcript.delta'({state, event}) {
        upsertEntry({
            state,
            id: event.item_id || createCuid2(),
            speaker: VoiceSpeaker.Assistant,
            update(text) {
                return text + (event.delta || '');
            },
        });
    },
    'response.output_audio_transcript.done'({state, event}) {
        upsertEntry({
            state,
            id: event.item_id || createCuid2(),
            speaker: VoiceSpeaker.Assistant,
            update(text) {
                return event.transcript || text;
            },
        });
    },
    error({state, event}) {
        state.error.setValue(JSON.stringify(event.error));
    },
};

function handleChannelMessage(state: Readonly<VoiceCallState>, data: unknown) {
    try {
        const event = checkWrapValidShape(JSON.parse(String(data)), channelEventShape, {
            allowExtraKeys: true,
        });
        if (event) {
            channelEventHandlers[event.type]?.({
                state,
                event,
            });
        }
    } catch (error) {
        state.error.setValue(
            `The voice call sent an unreadable event: ${extractErrorMessage(error)}`,
        );
    }
}

/** Hangs up the window's call, if it has one, or stops the one still connecting. */
export async function endVoiceCall(state: Readonly<VoiceCallState>) {
    const call = state.call.value;
    state.startId.setValue(undefined);
    if (!call) {
        /**
         * A connecting call has no `call` yet. Its `startVoiceCall` sees the cleared id and cleans
         * up.
         */
        state.status.setValue(VoiceCallStatus.Idle);
        return;
    }
    state.call.setValue(undefined);
    state.status.setValue(VoiceCallStatus.Idle);
    state.isMuted.setValue(false);
    call.peerConnection.close();
    call.microphone.getTracks().forEach((track) => track.stop());
    call.audio.srcObject = null;
    await call.removeListeners();
    await buildClient
        .call('endVoiceCall', {
            callId: call.callId,
        })
        .catch(() => undefined);
}

export function toggleVoiceMute(state: Readonly<VoiceCallState>) {
    const isMuted = !state.isMuted.value;
    state.call.value?.microphone.getAudioTracks().forEach((track) => {
        track.enabled = !isMuted;
    });
    state.isMuted.setValue(isMuted);
}

/**
 * Connects the microphone and speakers straight to OpenAI's realtime model over WebRTC. The server
 * makes the call, so the API key never reaches the browser.
 */
export async function startVoiceCall({
    state,
    openThread,
}: Readonly<{
    state: Readonly<VoiceCallState>;
    /** Shows a thread when the model asks to, in this window. */
    openThread(threadId: string): void;
}>) {
    if (state.status.value !== VoiceCallStatus.Idle) {
        return;
    }
    const startId = createCuid2();
    function isCancelled() {
        return state.startId.value !== startId;
    }
    function assertNotCancelled() {
        if (isCancelled()) {
            throw new Error('The voice call ended while it connected.');
        }
    }
    function failStart(message: string) {
        if (!isCancelled()) {
            state.error.setValue(message);
            state.status.setValue(VoiceCallStatus.Idle);
            state.startId.setValue(undefined);
        }
    }
    state.startId.setValue(startId);
    state.status.setValue(VoiceCallStatus.Connecting);
    state.error.setValue(undefined);
    state.transcript.setValue([]);
    const microphone = await navigator.mediaDevices
        .getUserMedia({
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
            },
        })
        .catch((error: unknown) => {
            failStart(`The microphone isn't available: ${extractErrorMessage(error)}`);
            return undefined;
        });
    if (!microphone) {
        return;
    } else if (isCancelled()) {
        microphone.getTracks().forEach((track) => track.stop());
        return;
    }
    const peerConnection = new RTCPeerConnection();
    const audio = new Audio();
    audio.autoplay = true;
    try {
        peerConnection.addEventListener('track', (event) => {
            audio.srcObject = event.streams[0] || null;
        });
        microphone.getAudioTracks().forEach((track) => {
            peerConnection.addTrack(track, microphone);
        });
        /**
         * OpenAI sends its events over a data channel of this name, which must exist before the
         * offer.
         */
        const channel = peerConnection.createDataChannel('oai-events');
        channel.addEventListener('open', () => {
            state.status.setValue(VoiceCallStatus.Live);
        });
        channel.addEventListener('message', (message) => {
            handleChannelMessage(state, message.data);
        });
        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);
        assertNotCancelled();
        const {callId, sdpAnswer} = await buildClient.call('startVoiceCall', {
            sdpOffer: offer.sdp || '',
        });
        try {
            assertNotCancelled();
            await peerConnection.setRemoteDescription({
                type: 'answer',
                sdp: sdpAnswer,
            });
            assertNotCancelled();
        } catch (error) {
            /** The server already holds the call open, and only its id can end it. */
            await buildClient
                .call('endVoiceCall', {
                    callId,
                })
                .catch(() => undefined);
            throw error;
        }
        const removers = [
            buildClient.listen('voiceToolRun', (run) => {
                if (run.callId !== callId) {
                    return;
                }
                state.transcript.setValue([
                    ...state.transcript.value,
                    {
                        id: createCuid2(),
                        speaker: VoiceSpeaker.Tool,
                        text: run.error ? `${run.toolName} failed: ${run.error}` : run.summary,
                        threadId: run.threadId,
                        isFailed: !!run.error,
                    },
                ]);
            }),
            buildClient.listen('voiceOpenThread', (request) => {
                if (request.callId === callId) {
                    openThread(request.threadId);
                }
            }),
        ];
        peerConnection.addEventListener('connectionstatechange', async () => {
            if (
                peerConnection.connectionState === 'failed' ||
                peerConnection.connectionState === 'closed'
            ) {
                await endVoiceCall(state);
            }
        });
        state.startId.setValue(undefined);
        state.call.setValue({
            callId,
            peerConnection,
            microphone,
            audio,
            async removeListeners() {
                await Promise.all(removers.map(async (remove) => await remove()));
            },
        });
    } catch (error) {
        peerConnection.close();
        microphone.getTracks().forEach((track) => track.stop());
        failStart(extractErrorMessage(error));
    }
}
