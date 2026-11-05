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

export type LaunchRequest = Pick<typeof launchPayloadShape.runtimeType, 'folder' | 'prompt'>;

/** Resolves to why the request was refused, or `undefined` when it was accepted. */
export type LaunchRequestHandler = (
    request: Readonly<LaunchRequest>,
) => Promise<string | undefined>;

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

/**
 * Parses a request file's text. Resolves to `{request}` when it is genuine, otherwise to
 * `{refusal}` saying why it must not be acted on.
 */
async function parseLaunchRequest(
    requestText: string,
): Promise<{request: LaunchRequest} | {refusal: string}> {
    const request = wrapInTry(() => parseJsonWithShape(requestText, signedLaunchRequestShape), {
        fallbackValue: undefined,
    });
    if (!request) {
        return {
            refusal: 'Expected a JSON object with string "payload" and "signature" properties.',
        };
    }
    const payload = wrapInTry(() => parseJsonWithShape(request.payload, launchPayloadShape), {
        fallbackValue: undefined,
    });
    if (!payload) {
        return {
            refusal:
                'Expected "payload" to hold string "conversationId", "folder", "prompt", and "requestId" properties and a number "createdAtMs".',
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
        request: {
            folder: payload.folder,
            prompt: payload.prompt,
        },
    };
}

async function handleLaunchRequestFile({
    fileName,
    launch,
}: Readonly<{
    fileName: string;
    launch: LaunchRequestHandler;
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
        const parsed = await parseLaunchRequest(await readFile(claimedPath, 'utf8'));
        const refusal = 'refusal' in parsed ? parsed.refusal : await launch(parsed.request);
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
            ((fileName.endsWith('.tmp') || fileName.endsWith('.error.txt')) &&
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
 * Hands every signed `<id>.json` request moved into `agentLaunchRequestsDir` to `launch`, including
 * any left there while the server was down. The file is deleted once handled. A refusal is written
 * to `<id>.error.txt` first, so a requester can wait for `<id>.json` and `<id>.processing` to both
 * be gone and then check for it.
 */
export async function startLaunchRequestWatch(launch: LaunchRequestHandler) {
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
                launch,
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
                launch,
            });
        }),
    );
}
