import {type FolderActivation} from '@agent-storm/common';
import {
    awaitedForEach,
    createCuid2,
    extractErrorMessage,
    extractExtension,
    filterObject,
    log,
    wrapInTry,
} from '@augment-vir/common';
import {convertDuration, type AnyDuration} from 'date-vir';
import {watch} from 'node:fs';
import {chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {defineShape, parseJsonWithShape} from 'object-shape-tester';
import {verifyLaunchSignature} from './daemon/daemon-client.js';
import {agentLaunchRequestsDir} from './file-paths.js';
import {type FinishReport, type FinishRequest} from './finish-worktree.js';

const activationState: {
    current: (FolderActivation & {requestedAtMs: number}) | undefined;
} = {
    current: undefined,
};

/**
 * Long enough for a frontend that polls folders to see the request, short enough that a frontend
 * opened later doesn't jump to a folder nobody asked it to show.
 */
const activationLifetime: AnyDuration = {
    minutes: 1,
};

/** Ask every open frontend to switch to `folder`. */
export function requestFolderActivation(folder: string) {
    activationState.current = {
        folder,
        requestId: createCuid2(),
        requestedAtMs: Date.now(),
    };
}

export function getFolderActivation(): FolderActivation | undefined {
    const current = activationState.current;
    if (
        !current ||
        Date.now() - current.requestedAtMs >
            convertDuration(activationLifetime, {
                milliseconds: true,
            }).milliseconds
    ) {
        return undefined;
    }
    return {
        folder: current.folder,
        requestId: current.requestId,
    };
}

const signedLaunchRequestShape = defineShape({
    /** The JSON text of a `launchPayloadShape`, kept as text so its signature covers exact bytes. */
    payload: '',
    /** Hex HMAC-SHA256 of `payload`, keyed by the requesting tab's `AGENT_STORM_LAUNCH_KEY`. */
    signature: '',
});

/** What a signed request asks for, as its payload's `action`. */
export enum AgentRequestAction {
    /** Payloads without an `action`, from scripts that predate it, are launches. */
    Launch = 'launch',
    /** Remove the requesting tab's own worktree. */
    Finish = 'finish',
}

const launchPayloadShape = defineShape({
    /** The requesting tab's `AGENT_STORM_CONVERSATION_ID`, which picks the key to verify with. */
    conversationId: '',
    /** Must already be one of the sidebar's folders. */
    folder: '',
    /** Typed into the folder's first AI tab as one line, so newlines are sent as spaces. */
    prompt: '',
    /** Accepted once. */
    requestId: '',
    createdAtMs: 0,
});

/** Also holds `action`, which {@link readPayloadAction} reads before this shape is checked. */
const finishPayloadShape = defineShape({
    /**
     * The requesting tab's `AGENT_STORM_CONVERSATION_ID`, which picks both the key to verify with
     * and the folder to remove. No path is ever taken from the request.
     */
    conversationId: '',
    isDryRun: false,
    shouldDiscard: false,
    requestId: '',
    createdAtMs: 0,
});

export type LaunchRequest = Pick<typeof launchPayloadShape.runtimeType, 'folder' | 'prompt'>;

export type AgentRequestHandlers = {
    /** Resolves to why the request was refused, or `undefined` when it was accepted. */
    launch: (request: Readonly<LaunchRequest>) => Promise<string | undefined>;
    /** A `report` is written to `<id>.result.json`, whether or not the request was refused. */
    finish: (
        request: Readonly<FinishRequest>,
    ) => Promise<{refusal?: string | undefined; report?: FinishReport | undefined}>;
};

type ParsedRequest =
    | {
          action: AgentRequestAction.Launch;
          request: LaunchRequest;
      }
    | {
          action: AgentRequestAction.Finish;
          request: FinishRequest;
      };

/**
 * How far a request's `createdAtMs` may be from now. Spent request ids only need remembering this
 * long, since anything older is refused by age.
 */
const requestAgeLimit: AnyDuration = {
    minutes: 1,
};

const spentRequestState: {
    /** Request id to when it was accepted. */
    spentAtMs: Partial<Record<string, number>>;
} = {
    spentAtMs: {},
};

/** Reads a payload's `action`, treating a payload without one as a launch. */
function readPayloadAction(payloadText: string): AgentRequestAction | undefined {
    const parsed: unknown = wrapInTry(() => JSON.parse(payloadText) as unknown, {
        fallbackValue: undefined,
    });
    if (!parsed || typeof parsed !== 'object' || !('action' in parsed)) {
        return AgentRequestAction.Launch;
    }
    return parsed.action === AgentRequestAction.Finish
        ? AgentRequestAction.Finish
        : parsed.action === AgentRequestAction.Launch
          ? AgentRequestAction.Launch
          : undefined;
}

/**
 * Parses a request file's text. Resolves to the request when it is genuine, otherwise to
 * `{refusal}` saying why it must not be acted on.
 */
async function parseAgentRequest(
    requestText: string,
): Promise<{parsed: ParsedRequest} | {refusal: string}> {
    const request = wrapInTry(() => parseJsonWithShape(requestText, signedLaunchRequestShape), {
        fallbackValue: undefined,
    });
    if (!request) {
        return {
            refusal: 'Expected a JSON object with string "payload" and "signature" properties.',
        };
    }
    const action = readPayloadAction(request.payload);
    const payload =
        action === AgentRequestAction.Finish
            ? wrapInTry(
                  () => {
                      return {
                          ...parseJsonWithShape(request.payload, finishPayloadShape),
                          action,
                      } as const;
                  },
                  {
                      fallbackValue: undefined,
                  },
              )
            : action === AgentRequestAction.Launch
              ? wrapInTry(
                    () => {
                        return {
                            ...parseJsonWithShape(request.payload, launchPayloadShape),
                            action,
                        } as const;
                    },
                    {
                        fallbackValue: undefined,
                    },
                )
              : undefined;
    if (!payload) {
        return {
            refusal:
                action === AgentRequestAction.Finish
                    ? 'Expected "payload" to hold string "conversationId" and "requestId" properties, boolean "isDryRun" and "shouldDiscard" properties, and a number "createdAtMs".'
                    : action === AgentRequestAction.Launch
                      ? 'Expected "payload" to hold string "conversationId", "folder", "prompt", and "requestId" properties and a number "createdAtMs".'
                      : `Expected "payload" to have an "action" of "${AgentRequestAction.Launch}" or "${AgentRequestAction.Finish}".`,
        };
    }
    const isSigned = await verifyLaunchSignature({
        conversationId: payload.conversationId,
        payload: request.payload,
        signature: request.signature,
    });
    if (!isSigned) {
        return {
            refusal: 'The signature does not match any running agent-storm AI tab.',
        };
    }
    const nowMs = Date.now();
    const ageLimitMs = convertDuration(requestAgeLimit, {
        milliseconds: true,
    }).milliseconds;
    if (Math.abs(nowMs - payload.createdAtMs) > ageLimitMs) {
        return {
            refusal: 'The request is too old. Sign a new one.',
        };
    }
    const unexpiredSpentAtMs = filterObject(
        spentRequestState.spentAtMs,
        (_requestId, spentAtMs) => {
            return nowMs - spentAtMs <= ageLimitMs * 2;
        },
    );
    if (unexpiredSpentAtMs[payload.requestId] != undefined) {
        spentRequestState.spentAtMs = unexpiredSpentAtMs;
        return {
            refusal: 'This request was already used. Sign a new one.',
        };
    }
    spentRequestState.spentAtMs = {
        ...unexpiredSpentAtMs,
        [payload.requestId]: nowMs,
    };
    return {
        parsed:
            payload.action === AgentRequestAction.Finish
                ? {
                      action: payload.action,
                      request: {
                          conversationId: payload.conversationId,
                          isDryRun: payload.isDryRun,
                          shouldDiscard: payload.shouldDiscard,
                      },
                  }
                : {
                      action: payload.action,
                      request: {
                          folder: payload.folder,
                          prompt: payload.prompt,
                      },
                  },
    };
}

/** Hands a genuine request to its handler. Resolves to the refusal and report to write back. */
async function dispatchAgentRequest({
    parsed,
    handlers,
}: Readonly<{
    parsed: Readonly<ParsedRequest>;
    handlers: Readonly<AgentRequestHandlers>;
}>): Promise<{refusal?: string | undefined; report?: FinishReport | undefined}> {
    if (parsed.action === AgentRequestAction.Finish) {
        return await handlers.finish(parsed.request);
    }
    return {
        refusal: await handlers.launch(parsed.request),
    };
}

async function handleLaunchRequestFile({
    fileName,
    handlers,
}: Readonly<{
    fileName: string;
    handlers: Readonly<AgentRequestHandlers>;
}>) {
    const {basename: requestId, extension} = extractExtension(fileName);
    if (extension !== '.json') {
        return;
    }
    const claimedPath = join(agentLaunchRequestsDir, `${requestId}.processing`);
    try {
        /** One file fires several watch events. Only the first rename succeeds. */
        await rename(join(agentLaunchRequestsDir, fileName), claimedPath);
    } catch {
        return;
    }
    try {
        const parseResult = await parseAgentRequest(await readFile(claimedPath, 'utf8'));
        const {refusal, report} =
            'refusal' in parseResult
                ? {
                      refusal: parseResult.refusal,
                      report: undefined,
                  }
                : await dispatchAgentRequest({
                      parsed: parseResult.parsed,
                      handlers,
                  });
        if (report) {
            await writeFile(
                join(agentLaunchRequestsDir, `${requestId}.result.json`),
                JSON.stringify(report, undefined, 4),
            );
        }
        if (refusal) {
            await writeFile(join(agentLaunchRequestsDir, `${requestId}.error.txt`), refusal);
        }
    } catch (error) {
        await writeFile(
            join(agentLaunchRequestsDir, `${requestId}.error.txt`),
            extractErrorMessage(error),
        );
    } finally {
        await rm(claimedPath, {
            force: true,
        });
    }
}

/**
 * Deletes what a previous server run left behind: claims it never finished, and request and refusal
 * files no requester is still waiting on.
 */
async function removeLeftoverRequestFiles() {
    const nowMs = Date.now();
    await awaitedForEach(await readdir(agentLaunchRequestsDir), async (fileName) => {
        const path = join(agentLaunchRequestsDir, fileName);
        const isStale =
            fileName.endsWith('.processing') ||
            ((fileName.endsWith('.tmp') ||
                fileName.endsWith('.error.txt') ||
                fileName.endsWith('.result.json')) &&
                nowMs - ((await stat(path).catch(() => undefined))?.mtimeMs ?? nowMs) >
                    convertDuration(requestAgeLimit, {
                        milliseconds: true,
                    }).milliseconds);
        if (isStale) {
            await rm(path, {
                force: true,
            });
        }
    });
}

/**
 * Hands every signed `<id>.json` request moved into `agentLaunchRequestsDir` to its action's
 * handler, including any left there while the server was down. The file is deleted once handled. A
 * refusal is written to `<id>.error.txt` and a report to `<id>.result.json` first, so a requester
 * can wait for `<id>.json` and `<id>.processing` to both be gone and then check for them.
 */
export async function startLaunchRequestWatch(handlers: Readonly<AgentRequestHandlers>) {
    await mkdir(agentLaunchRequestsDir, {
        recursive: true,
        mode: 0o700,
    });
    /** `mkdir` leaves an existing folder's mode alone. */
    await chmod(agentLaunchRequestsDir, 0o700);
    await removeLeftoverRequestFiles();
    watch(agentLaunchRequestsDir, (_eventType, fileName) => {
        if (fileName) {
            handleLaunchRequestFile({
                fileName,
                handlers,
            }).catch((error: unknown) => {
                log.warning(
                    `Failed to handle launch request ${fileName}: ${extractErrorMessage(error)}`,
                );
            });
        }
    }).on('error', (error) => {
        log.warning(`Stopped watching for launch requests: ${extractErrorMessage(error)}`);
    });
    await Promise.all(
        (await readdir(agentLaunchRequestsDir)).map(async (fileName) => {
            await handleLaunchRequestFile({
                fileName,
                handlers,
            });
        }),
    );
}
