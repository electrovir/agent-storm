import {type PluginCallHandlers, type PluginServerContext} from '@agent-storm/core/server';
import {check} from '@augment-vir/assert';
import {awaitedForEach, extractErrorMessage, log, wrapPromiseInTimeout} from '@augment-vir/common';
import {readFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {basename, join} from 'node:path';
import {
    checkWrapValidShape,
    defineShape,
    exactShape,
    nullableShape,
    optionalShape,
    unknownShape,
} from 'object-shape-tester';
import {type buildApi, type Thread, ThreadOrigin, ThreadStatus} from '../build-api.js';
import {
    describeThread,
    voiceInstructions,
    type VoiceToolContext,
    voiceTools,
} from './voice-tools.js';

const realtimeModel = 'gpt-realtime-2.1';
const realtimeCallsUrl = 'https://api.openai.com/v1/realtime/calls';

const codexAuthShape = defineShape({
    OPENAI_API_KEY: nullableShape(''),
});

/**
 * `OPENAI_API_KEY` from the environment, else the API key Codex signed in with. Throws when there's
 * neither.
 */
async function readOpenAiApiKey() {
    if (process.env.OPENAI_API_KEY) {
        return process.env.OPENAI_API_KEY;
    }
    const contents = await readFile(join(homedir(), '.codex', 'auth.json'), 'utf8').catch(() => '');
    try {
        const auth = checkWrapValidShape(JSON.parse(contents), codexAuthShape, {
            allowExtraKeys: true,
        });
        if (auth?.OPENAI_API_KEY) {
            return auth.OPENAI_API_KEY;
        }
    } catch {
        /** A missing or unreadable auth file is the same as one without a key. */
    }
    throw new Error(
        'Voice calls need an OpenAI API key: set OPENAI_API_KEY, or sign Codex in with an API key.',
    );
}

/**
 * Node's `WebSocket` takes request headers in its second argument, which OpenAI's sideband
 * connection needs for its API key. The DOM lib this project also loads types that argument as
 * subprotocols only.
 */
const HeaderWebSocket = WebSocket satisfies typeof WebSocket as unknown as new (
    url: string,
    init: Readonly<{
        headers: Readonly<Record<string, string>>;
    }>,
) => WebSocket;

const functionCallItemShape = defineShape({
    type: exactShape('function_call'),
    name: '',
    call_id: '',
    arguments: '',
});

const realtimeEventShape = defineShape({
    type: '',
    response: optionalShape(
        {
            output: [
                unknownShape(),
            ],
        },
        {
            alsoUndefined: true,
        },
    ),
    error: optionalShape(unknownShape(), {
        alsoUndefined: true,
    }),
});

type RealtimeEvent = typeof realtimeEventShape.runtimeType;

/**
 * What a voice call tells its model when a thread's status changes, keyed by the new status. Empty
 * for none.
 */
const statusUpdateTexts: Readonly<Record<ThreadStatus, string>> = {
    [ThreadStatus.Idle]: 'finished its turn',
    [ThreadStatus.Running]: '',
    [ThreadStatus.NeedsApproval]:
        'is waiting on the user to approve something or answer a question',
    [ThreadStatus.Failed]: 'failed',
};

/**
 * The system message a voice call's model gets when `thread` changes from `previousStatus`.
 * Undefined when the change isn't worth speaking up about, such as a thread the call hasn't seen
 * before or one leaving `NeedsApproval` without running.
 */
export function findStatusUpdate({
    previousStatus,
    thread,
}: Readonly<{
    previousStatus: ThreadStatus | undefined;
    thread: Readonly<Pick<Thread, 'title' | 'status' | 'origin'>>;
}>) {
    const text = statusUpdateTexts[thread.status];
    const isAnnounced =
        !!text &&
        !!previousStatus &&
        previousStatus !== thread.status &&
        thread.origin === ThreadOrigin.User &&
        (thread.status !== ThreadStatus.Idle || previousStatus === ThreadStatus.Running);
    /** JSON quoting keeps a title's quotes and line breaks from reading as more of the message. */
    return isAnnounced ? `Update: thread ${JSON.stringify(thread.title)} ${text}.` : undefined;
}

/** One running voice call: the server's sideband connection to it and what it has seen. */
type VoiceSession = Readonly<{
    socket: WebSocket;
    /** Each thread's status as last seen, to notice changes. */
    threadStatuses: Map<string, ThreadStatus>;
    flags: {
        isResponseActive: boolean;
        isUpdatePending: boolean;
    };
}>;

function sendRealtimeEvent(socket: Readonly<WebSocket>, event: Readonly<Record<string, unknown>>) {
    if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(event));
    }
}

/** Runs voice calls' tools and keeps their models told about thread changes. */
export function createVoiceCalls({
    emit,
    host,
}: Readonly<{
    emit: PluginServerContext<typeof buildApi>['emit'];
    host: Pick<VoiceToolContext, 'listFolders' | 'loadSettings'>;
}>) {
    const sessions = new Map<string, VoiceSession>();

    async function runFunctionCalls({
        callId,
        session,
        outputItems,
        calls,
    }: Readonly<{
        callId: string;
        session: VoiceSession;
        outputItems: ReadonlyArray<unknown>;
        calls: PluginCallHandlers<typeof buildApi>;
    }>) {
        const functionCalls = outputItems
            .map((item) => {
                return checkWrapValidShape(item, functionCallItemShape, {
                    allowExtraKeys: true,
                });
            })
            .filter(check.isTruthy);
        if (!functionCalls.length) {
            if (session.flags.isUpdatePending) {
                session.flags.isUpdatePending = false;
                sendRealtimeEvent(session.socket, {
                    type: 'response.create',
                });
            }
            return;
        }
        await awaitedForEach(functionCalls, async (functionCall) => {
            const tool = voiceTools.find((voiceTool) => voiceTool.name === functionCall.name);
            try {
                if (!tool) {
                    throw new Error(`There's no tool named ${functionCall.name}.`);
                }
                const result = await tool.run({
                    input: JSON.parse(functionCall.arguments || '{}'),
                    context: {
                        calls,
                        ...host,
                        openThread(threadId) {
                            emit('voiceOpenThread', {
                                callId,
                                threadId,
                            });
                        },
                    },
                });
                emit('voiceToolRun', {
                    callId,
                    toolName: functionCall.name,
                    summary: result.summary,
                    threadId: result.threadId,
                    error: '',
                });
                sendRealtimeEvent(session.socket, {
                    type: 'conversation.item.create',
                    item: {
                        type: 'function_call_output',
                        call_id: functionCall.call_id,
                        output: JSON.stringify(result.output),
                    },
                });
            } catch (error) {
                const message = extractErrorMessage(error);
                emit('voiceToolRun', {
                    callId,
                    toolName: functionCall.name,
                    summary: '',
                    threadId: '',
                    error: message,
                });
                sendRealtimeEvent(session.socket, {
                    type: 'conversation.item.create',
                    item: {
                        type: 'function_call_output',
                        call_id: functionCall.call_id,
                        output: JSON.stringify({
                            error: message,
                        }),
                    },
                });
            }
        });
        session.flags.isUpdatePending = false;
        sendRealtimeEvent(session.socket, {
            type: 'response.create',
        });
    }

    function handleRealtimeEvent({
        callId,
        session,
        event,
        calls,
    }: Readonly<{
        callId: string;
        session: VoiceSession;
        event: RealtimeEvent;
        calls: PluginCallHandlers<typeof buildApi>;
    }>) {
        if (event.type === 'response.created') {
            session.flags.isResponseActive = true;
        } else if (event.type === 'response.done') {
            session.flags.isResponseActive = false;
            void runFunctionCalls({
                callId,
                session,
                outputItems: event.response?.output || [],
                calls,
            });
        } else if (event.type === 'error') {
            log.warning(`Voice call ${callId} got an error: ${JSON.stringify(event.error)}`);
        }
    }

    return {
        /** Connects the browser's WebRTC offer to a new realtime call. */
        async startCall({
            sdpOffer,
            calls,
        }: Readonly<{
            sdpOffer: string;
            calls: PluginCallHandlers<typeof buildApi>;
        }>) {
            const apiKey = await readOpenAiApiKey();
            const {threads} = await calls.listThreads({});
            const form = new FormData();
            form.set('sdp', sdpOffer);
            form.set(
                'session',
                JSON.stringify({
                    type: 'realtime',
                    model: realtimeModel,
                    instructions: [
                        voiceInstructions,
                        `Briefing on the threads as the call started: ${JSON.stringify(
                            threads.map(describeThread),
                        )}`,
                    ].join('\n\n'),
                    tool_choice: 'auto',
                    tools: voiceTools.map((tool) => {
                        return {
                            type: 'function',
                            name: tool.name,
                            description: tool.description,
                            parameters: tool.parameters,
                        };
                    }),
                    audio: {
                        input: {
                            transcription: {
                                model: 'gpt-4o-transcribe',
                            },
                            turn_detection: {
                                type: 'semantic_vad',
                                eagerness: 'auto',
                                interrupt_response: true,
                                create_response: true,
                            },
                        },
                        output: {
                            voice: 'marin',
                        },
                    },
                }),
            );
            const response = await fetch(realtimeCallsUrl, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${apiKey}`,
                },
                body: form,
            });
            const sdpAnswer = await response.text();
            if (!response.ok) {
                throw new Error(`OpenAI refused the voice call (${response.status}): ${sdpAnswer}`);
            }
            const callLocation = response.headers.get('Location');
            if (!callLocation) {
                throw new Error("OpenAI's answer to the voice call had no call id.");
            }
            const callId = basename(callLocation);
            const socket = new HeaderWebSocket(
                `wss://api.openai.com/v1/realtime?call_id=${encodeURIComponent(callId)}`,
                {
                    headers: {
                        Authorization: `Bearer ${apiKey}`,
                    },
                },
            );
            const session: VoiceSession = {
                socket,
                threadStatuses: new Map(
                    threads.map((thread) => {
                        return [
                            thread.id,
                            thread.status,
                        ];
                    }),
                ),
                flags: {
                    isResponseActive: false,
                    isUpdatePending: false,
                },
            };
            socket.addEventListener('message', (message) => {
                try {
                    const event = checkWrapValidShape(
                        JSON.parse(String(message.data)),
                        realtimeEventShape,
                        {
                            allowExtraKeys: true,
                        },
                    );
                    if (event) {
                        handleRealtimeEvent({
                            callId,
                            session,
                            event,
                            calls,
                        });
                    }
                } catch (error) {
                    log.warning(
                        `Voice call ${callId} sent an unreadable event: ${extractErrorMessage(error)}`,
                    );
                }
            });
            socket.addEventListener('close', () => {
                sessions.delete(callId);
            });
            await wrapPromiseInTimeout(
                {
                    seconds: 15,
                },
                new Promise<void>((resolve, reject) => {
                    socket.addEventListener('open', () => resolve());
                    socket.addEventListener('error', () => {
                        return reject(new Error("Connecting to the voice call's controls failed."));
                    });
                }),
            ).catch((error: unknown) => {
                /** The socket isn't in `sessions` yet, so neither `endCall` nor `stop` can close it. */
                socket.close();
                throw error;
            });
            sessions.set(callId, session);
            return {
                callId,
                sdpAnswer,
            };
        },
        endCall(callId: string) {
            sessions.get(callId)?.socket.close();
            sessions.delete(callId);
        },
        /** Tells every call's model when `thread`'s status changes in a way worth hearing about. */
        observeThread(thread: Readonly<Thread>) {
            sessions.forEach((session) => {
                const update = findStatusUpdate({
                    previousStatus: session.threadStatuses.get(thread.id),
                    thread,
                });
                session.threadStatuses.set(thread.id, thread.status);
                if (!update) {
                    return;
                }
                sendRealtimeEvent(session.socket, {
                    type: 'conversation.item.create',
                    item: {
                        type: 'message',
                        role: 'system',
                        content: [
                            {
                                type: 'input_text',
                                text: update,
                            },
                        ],
                    },
                });
                /**
                 * Only one response may run at a time, so mid-response the update waits for that
                 * response to end.
                 */
                if (session.flags.isResponseActive) {
                    session.flags.isUpdatePending = true;
                } else {
                    sendRealtimeEvent(session.socket, {
                        type: 'response.create',
                    });
                }
            });
        },
        stop() {
            sessions.forEach((session) => session.socket.close());
            sessions.clear();
        },
    };
}
