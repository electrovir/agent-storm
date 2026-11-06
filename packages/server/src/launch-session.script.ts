import {waitUntil} from '@augment-vir/assert';
import {log} from '@augment-vir/common';
import {createHmac, randomUUID} from 'node:crypto';
import {access, readFile, rename, rm, writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {parseArgs} from 'node:util';

/**
 * Asks the running agent-storm to type `--prompt` into `--folder`'s first AI tab without moving any
 * window's focus to it. Only works inside an agent-storm AI tab, whose environment holds the key
 * that signs the request.
 *
 * Exits 0 once agent-storm accepts the request, 1 when it refuses (printing why), and 2 when
 * nothing picks the request up, which means agent-storm is not running or predates signed
 * requests.
 */

/**
 * AI tabs run this with plain `node`, which cannot resolve this package's `.js` imports to their
 * `.ts` sources, so `agentLaunchRequestsDir` from `file-paths.ts` is restated rather than imported.
 * Agent-storm gives every tab its instance's data dir as `AGENT_STORM_DATA_DIR`.
 */
const requestsDir = join(
    process.env.AGENT_STORM_DATA_DIR || join(homedir(), '.agent-storm'),
    'launch-requests',
);

async function exists(path: string) {
    try {
        await access(path);
        return true;
    } catch {
        return false;
    }
}

const {values} = parseArgs({
    options: {
        folder: {
            type: 'string',
        },
        prompt: {
            type: 'string',
        },
    },
});
const conversationId = process.env.AGENT_STORM_CONVERSATION_ID;
const launchKey = process.env.AGENT_STORM_LAUNCH_KEY;

if (!values.folder || !values.prompt) {
    log.error('Pass both --folder and --prompt.');
    process.exit(1);
}
if (!conversationId || !launchKey) {
    log.error('Not running inside an agent-storm AI tab that can launch sessions.');
    process.exit(2);
}
if (!(await exists(requestsDir))) {
    log.error('agent-storm has not created its launch requests folder.');
    process.exit(2);
}

const requestId = randomUUID();
const payload = JSON.stringify({
    conversationId,
    folder: values.folder,
    prompt: values.prompt,
    requestId,
    createdAtMs: Date.now(),
});
const requestPath = join(requestsDir, `${requestId}.json`);
const temporaryPath = join(requestsDir, `${requestId}.tmp`);
const processingPath = join(requestsDir, `${requestId}.processing`);
const errorPath = join(requestsDir, `${requestId}.error.txt`);

await writeFile(
    temporaryPath,
    JSON.stringify({
        payload,
        signature: createHmac('sha256', launchKey).update(payload).digest('hex'),
    }),
    {
        mode: 0o600,
    },
);
/** Agent-storm only reads `.json` files, so it never sees a half-written request. */
await rename(temporaryPath, requestPath);

try {
    await waitUntil.isFalse(() => exists(requestPath), {
        interval: {
            milliseconds: 100,
        },
        timeout: {
            seconds: 10,
        },
    });
} catch {
    await rm(requestPath, {
        force: true,
    });
    log.error('agent-storm did not pick up the launch request.');
    process.exit(2);
}
try {
    await waitUntil.isFalse(() => exists(processingPath), {
        interval: {
            milliseconds: 100,
        },
        timeout: {
            minutes: 1,
        },
    });
} catch {
    log.error('agent-storm picked up the launch request but did not finish handling it.');
    process.exit(1);
}

if (await exists(errorPath)) {
    const refusal = await readFile(errorPath, 'utf8');
    await rm(errorPath, {
        force: true,
    });
    log.error(refusal);
    process.exit(1);
}
log.success(`agent-storm is launching a session in ${values.folder}.`);
