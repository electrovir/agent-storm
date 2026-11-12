import {waitUntil} from '@augment-vir/assert';
import {log} from '@augment-vir/common';
import {createHmac, randomUUID} from 'node:crypto';
import {access, readFile, rename, rm, writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {parseArgs} from 'node:util';

/**
 * Sends the running agent-storm a request signed with this AI tab's key. Only works inside an
 * agent-storm AI tab, whose environment holds that key.
 *
 * - `--folder <path> --prompt <text>`: type the prompt into the folder's first AI tab without moving
 *   any window's focus to it.
 * - `finish [--dry-run] [--discard]`: remove the worktree this tab is in, closing this tab and every
 *   other tab in it, and delete its local branch when that is verifiably safe. `--dry-run` only
 *   prints the JSON report of what would happen. Without `--discard`, agent-storm refuses when the
 *   removal would destroy uncommitted files or commits no remote has.
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

const {values, positionals} = parseArgs({
    allowPositionals: true,
    options: {
        folder: {
            type: 'string',
        },
        prompt: {
            type: 'string',
        },
        'dry-run': {
            type: 'boolean',
        },
        discard: {
            type: 'boolean',
        },
    },
});
const isFinish = positionals[0] === 'finish';
const conversationId = process.env.AGENT_STORM_CONVERSATION_ID;
const launchKey = process.env.AGENT_STORM_LAUNCH_KEY;

if (positionals.length > (isFinish ? 1 : 0)) {
    log.error(`Unexpected argument "${positionals.join(' ')}". Only "finish" is accepted.`);
    process.exit(1);
}
if (!isFinish && (!values.folder || !values.prompt)) {
    log.error('Pass both --folder and --prompt, or "finish".');
    process.exit(1);
}
if (!conversationId || !launchKey) {
    log.error('Not running inside an agent-storm AI tab that can send requests.');
    process.exit(2);
}
if (!(await exists(requestsDir))) {
    log.error('agent-storm has not created its launch requests folder.');
    process.exit(2);
}

const requestId = randomUUID();
const payload = JSON.stringify(
    isFinish
        ? {
              action: 'finish',
              conversationId,
              isDryRun: !!values['dry-run'],
              shouldDiscard: !!values.discard,
              requestId,
              createdAtMs: Date.now(),
          }
        : {
              conversationId,
              folder: values.folder,
              prompt: values.prompt,
              requestId,
              createdAtMs: Date.now(),
          },
);
const requestPath = join(requestsDir, `${requestId}.json`);
const temporaryPath = join(requestsDir, `${requestId}.tmp`);
const processingPath = join(requestsDir, `${requestId}.processing`);
const errorPath = join(requestsDir, `${requestId}.error.txt`);
const resultPath = join(requestsDir, `${requestId}.result.json`);

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
    log.error('agent-storm did not pick up the request.');
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
    log.error('agent-storm picked up the request but did not finish handling it.');
    process.exit(1);
}

if (await exists(resultPath)) {
    console.info(await readFile(resultPath, 'utf8'));
    await rm(resultPath, {
        force: true,
    });
}
if (await exists(errorPath)) {
    const refusal = await readFile(errorPath, 'utf8');
    await rm(errorPath, {
        force: true,
    });
    log.error(refusal);
    process.exit(1);
}
if (!isFinish) {
    log.success(`agent-storm is launching a session in ${values.folder}.`);
} else if (!values['dry-run']) {
    log.success('agent-storm accepted. It will close this tab and remove the worktree.');
}
