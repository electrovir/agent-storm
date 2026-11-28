// cspell:words abposr akia bxox pousr
import {check} from '@augment-vir/assert';
import {getObjectTypedValues, removeDuplicates, wrapInTry} from '@augment-vir/common';
import {readFileIfExists} from '@augment-vir/node';
import {
    gitTimeout,
    normalizePath,
    readOnlyGitEnv,
    runCommand,
    tryGit,
    writeFileAtomically,
} from 'agent-storm-util';
import {type AnyDuration, convertDuration, createUtcFullDate, toUtcIsoString} from 'date-vir';
import {createReadStream} from 'node:fs';
import {readdir, stat} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {createInterface} from 'node:readline';
import {
    checkWrapValidShape,
    defineShape,
    enumShape,
    optionalShape,
    parseJsonWithShape,
    type Shape,
    unknownShape,
} from 'object-shape-tester';

/** The digest keeps the latest sessions and fix commits, so it stays short enough to read. */
const maxDigestSessions = 150;
const maxDigestFixCommits = 200;
const fixCommitLogMaxBytes = 32 * 1024 * 1024;

/** Where the user typed a request. */
export enum FixRequestSource {
    AgentStorm = 'agent-storm',
    ClaudeCli = 'claude-cli',
    CodexCli = 'codex-cli',
}

const fixRequestShape = defineShape({
    source: enumShape(FixRequestSource),
    sessionId: '',
    /** Epoch milliseconds. */
    sentAt: 0,
    text: '',
});

type FixRequest = typeof fixRequestShape.runtimeType;

const ledgerShape = defineShape({
    /** Epoch milliseconds. Session lines sent before this were already read. */
    scannedAt: 0,
    requests: [
        fixRequestShape,
    ],
});

/** How far back the first scan reaches, and how long a request is kept after it. */
const requestRetention = {
    days: 90,
} as const satisfies AnyDuration;

/** Messages agent-storm itself sends to its threads, which aren't the user's requests. */
const automatedPrefixes = [
    'Agent Storm restarted',
    'Agent Storm was shut down',
    'Agent Storm watch mode',
    'Agent Storm self-improvement',
    'This conversation started with another AI agent',
    'This session is being continued',
    '# AGENTS.md',
];

const claudeEntryShape = defineShape({
    type: '',
    cwd: '',
    sessionId: '',
    timestamp: '',
    entrypoint: optionalShape('', {
        alsoUndefined: true,
    }),
    origin: {
        kind: '',
    },
    message: {
        content: unknownShape(),
    },
});

const codexMetaShape = defineShape({
    type: '',
    payload: {
        id: '',
        cwd: '',
        originator: '',
    },
});

const codexEntryShape = defineShape({
    timestamp: '',
    type: '',
    payload: {
        type: '',
        role: '',
        content: [
            {
                type: '',
                text: optionalShape('', {
                    alsoUndefined: true,
                }),
            },
        ],
    },
});

function parseLine<const LineShape extends Shape>(line: string, shape: LineShape) {
    const parsed: unknown = wrapInTry(() => JSON.parse(line), {
        fallbackValue: undefined,
    });
    return checkWrapValidShape(parsed, shape, {
        allowExtraKeys: true,
    });
}

/**
 * The text of a human message, or undefined for one agent-storm or a CLI wrote on the user's
 * behalf. Leading pasted image paths are dropped, since only the words say what broke.
 */
function toRequestText(text: string) {
    const trimmed = text.replace(/^(?:\S+\.(?:png|jpe?g|gif|webp)\s*)+/i, '').trim();
    const isAutomated =
        trimmed.startsWith('<') ||
        automatedPrefixes.some((prefix) => {
            return trimmed.startsWith(prefix);
        });
    /** Short replies like "yes" or "go" only answer the agent. */
    return isAutomated || trimmed.length < 12 ? undefined : trimmed;
}

function isInFolders(cwd: string, folders: ReadonlyArray<string>) {
    return folders.some((folder) => {
        return cwd === folder || cwd.startsWith(`${folder}/`);
    });
}

/** Each line of a session log that `toValue` turns into a value. */
async function mapSessionLines<Value>(
    filePath: string,
    toValue: (line: string) => Value | undefined,
) {
    const lines = createInterface({
        input: createReadStream(filePath),
        crlfDelay: Infinity,
    });
    const values: Value[] = [];
    try {
        for await (const line of lines) {
            const value = toValue(line);
            if (value != undefined) {
                values.push(value);
            }
        }
    } catch {
        /** The CLIs delete old session logs, so one can vanish between listing and reading. */
        return [];
    }
    return values;
}

async function readFirstLine(filePath: string) {
    const input = createReadStream(filePath);
    try {
        for await (const line of createInterface({
            input,
            crlfDelay: Infinity,
        })) {
            return line;
        }
        return '';
    } catch {
        /** Same as `mapSessionLines`: a vanished log has nothing to read. */
        return '';
    } finally {
        input.destroy();
    }
}

/** The `.jsonl` files under `dir` changed after `since`, as absolute paths. */
async function listChangedLogs({
    dir,
    since,
    isRecursive,
}: Readonly<{dir: string; since: number; isRecursive: boolean}>) {
    const names = await readdir(dir, {
        recursive: isRecursive,
    }).catch(() => []);
    const changed = await Promise.all(
        names
            .filter((name) => name.endsWith('.jsonl'))
            .map(async (name) => {
                const filePath = join(dir, name);
                const modifiedAt = (await stat(filePath).catch(() => undefined))?.mtimeMs ?? 0;
                return modifiedAt > since ? filePath : undefined;
            }),
    );
    return changed.filter((filePath) => filePath != undefined);
}

type ScanWindow = Readonly<{
    folders: ReadonlyArray<string>;
    /** Epoch milliseconds, exclusive. */
    since: number;
    /** Epoch milliseconds, inclusive. */
    until: number;
}>;

function isInWindow(sentAt: number, {since, until}: ScanWindow) {
    return sentAt > since && sentAt <= until;
}

function readClaudeText(content: unknown) {
    if (check.isString(content)) {
        return content;
    } else if (check.isArray(content)) {
        return content
            .map((part: unknown) => {
                return check.isObject(part) && part.type === 'text' && check.isString(part.text)
                    ? part.text
                    : '';
            })
            .join('\n');
    } else {
        return '';
    }
}

/**
 * Claude names each project folder after its working directory with every character but letters and
 * digits replaced by `-`, so a folder's sessions, and its subfolders', start with that name.
 */
async function readClaudeRequests(window: ScanWindow) {
    const projectsDir = join(homedir(), '.claude', 'projects');
    const prefixes = window.folders.map((folder) => folder.replace(/[^a-zA-Z0-9]/g, '-'));
    const projectNames = (await readdir(projectsDir).catch(() => [])).filter((name) => {
        return prefixes.some((prefix) => name.startsWith(prefix));
    });
    const files = (
        await Promise.all(
            projectNames.map(async (name) => {
                return await listChangedLogs({
                    dir: join(projectsDir, name),
                    since: window.since,
                    isRecursive: false,
                });
            }),
        )
    ).flat();
    return (
        await Promise.all(
            files.map(async (filePath) => {
                return await mapSessionLines(filePath, (line): FixRequest | undefined => {
                    if (!line.includes('"human"')) {
                        return undefined;
                    }
                    const entry = parseLine(line, claudeEntryShape);
                    const sentAt = entry ? Date.parse(entry.timestamp) : NaN;
                    const text =
                        entry?.type === 'user' &&
                        entry.origin.kind === 'human' &&
                        isInFolders(entry.cwd, window.folders) &&
                        isInWindow(sentAt, window)
                            ? toRequestText(readClaudeText(entry.message.content))
                            : undefined;
                    return entry && text
                        ? {
                              source:
                                  entry.entrypoint === 'cli'
                                      ? FixRequestSource.ClaudeCli
                                      : FixRequestSource.AgentStorm,
                              sessionId: entry.sessionId,
                              sentAt,
                              text,
                          }
                        : undefined;
                });
            }),
        )
    ).flat();
}

async function readCodexRequests(window: ScanWindow) {
    const files = await listChangedLogs({
        dir: join(homedir(), '.codex', 'sessions'),
        since: window.since,
        isRecursive: true,
    });
    return (
        await Promise.all(
            files.map(async (filePath) => {
                const meta = parseLine(await readFirstLine(filePath), codexMetaShape);
                if (
                    meta?.type !== 'session_meta' ||
                    !isInFolders(normalizePath(meta.payload.cwd), window.folders)
                ) {
                    return [];
                }
                return await mapSessionLines(filePath, (line): FixRequest | undefined => {
                    if (!line.includes('"role":"user"')) {
                        return undefined;
                    }
                    const entry = parseLine(line, codexEntryShape);
                    const sentAt = entry ? Date.parse(entry.timestamp) : NaN;
                    const text =
                        entry?.type === 'response_item' &&
                        entry.payload.type === 'message' &&
                        entry.payload.role === 'user' &&
                        isInWindow(sentAt, window)
                            ? toRequestText(
                                  entry.payload.content
                                      .map((part) => part.text || '')
                                      .filter((part) => !!toRequestText(part))
                                      .join('\n'),
                              )
                            : undefined;
                    return text
                        ? {
                              source:
                                  meta.payload.originator === 'agent-storm'
                                      ? FixRequestSource.AgentStorm
                                      : FixRequestSource.CodexCli,
                              sessionId: meta.payload.id,
                              sentAt,
                              text,
                          }
                        : undefined;
                });
            }),
        )
    ).flat();
}

/** The checkout and each of its worktrees. */
async function listCheckoutFolders(checkoutPath: string) {
    const worktrees = (
        (await tryGit(checkoutPath, [
            'worktree',
            'list',
            '--porcelain',
        ])) || ''
    )
        .split('\n')
        .filter((line) => line.startsWith('worktree '))
        .map((line) => normalizePath(line.slice('worktree '.length)));
    return removeDuplicates([
        normalizePath(checkoutPath),
        ...worktrees,
    ]);
}

/**
 * Commits from the retention window whose subject reads like a fix, each with the packages it
 * touched.
 */
async function readFixCommits(checkoutPath: string) {
    const recordSeparator = '\u001e';
    const {stdout} = await runCommand(
        'git',
        [
            'log',
            `--since=${requestRetention.days}.days`,
            '--no-merges',
            '--date=short',
            `--pretty=format:${recordSeparator}%ad %s`,
            '--name-only',
        ],
        {
            cwd: checkoutPath,
            env: readOnlyGitEnv,
            timeout: gitTimeout,
            maxBuffer: fixCommitLogMaxBytes,
        },
    );
    return stdout
        .split(recordSeparator)
        .map((record) => {
            const [
                subject = '',
                ...files
            ] = record.trim().split('\n');
            const areas = removeDuplicates(
                files
                    .filter(Boolean)
                    .map((file) => /^packages\/([^/]+)\//.exec(file)?.[1] || file.split('/')[0]),
            );
            return /\b(fix|bug|broke|broken|crash|stuck|wrong|again|regress|revert|flak)/i.test(
                subject,
            )
                ? [
                      `- ${subject}`,
                      ...(areas.length ? [`(${areas.join(', ')})`] : []),
                  ].join(' ')
                : undefined;
        })
        .filter((line) => line != undefined)
        .slice(0, maxDigestFixCommits);
}

/** Likely secrets, which never reach the digest, since an AI provider reads it. */
const secretPatterns = [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    /\b(?:sk|pk|rk)-[\w-]{16,}/g,
    /\b(?:gh[pousr]_|github_pat_)\w{20,}/g,
    /\bxox[abposr]-[\w-]{10,}/g,
    /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    /\bnpm_\w{30,}/g,
    /\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g,
    /\bBearer\s+[\w.~+/-]{12,}=*/gi,
];

/** Hides the value of a `token=...` or `password: ...` style assignment, keeping its key. */
const secretAssignmentPattern =
    /\b(api[_-]?key|access[_-]?token|token|secret|password|passwd)(\s*[:=]\s*)["']?[^\s"']{6,}["']?/gi;

function redactSecrets(text: string) {
    return secretPatterns.reduce(
        (redacted, pattern) => redacted.replace(pattern, '[redacted]'),
        text.replace(secretAssignmentPattern, '$1$2[redacted]'),
    );
}

function shorten(text: string, maxLength: number) {
    const flattened = redactSecrets(text).replace(/\s+/g, ' ').trim();
    return flattened.length > maxLength ? `${flattened.slice(0, maxLength - 1)}…` : flattened;
}

function formatRequests(requests: ReadonlyArray<FixRequest>) {
    const sessions = getObjectTypedValues(
        Object.groupBy(requests, (request) => request.sessionId),
    ).filter(check.isDefined);
    return sessions
        .map((session) => session.toSorted((first, second) => first.sentAt - second.sentAt))
        .toSorted((first, second) => (second.at(-1)?.sentAt ?? 0) - (first.at(-1)?.sentAt ?? 0))
        .slice(0, maxDigestSessions)
        .map((session) => {
            const [
                first,
                ...followUps
            ] = session;
            return [
                `- ${toUtcIsoString(createUtcFullDate(first?.sentAt ?? 0)).slice(0, 10)} (${first?.source}): ${shorten(first?.text || '', 400)}`,
                ...followUps
                    .slice(0, 2)
                    .map((followUp) => `    - then: ${shorten(followUp.text, 200)}`),
                ...(followUps.length > 2 ? [`    - (${followUps.length - 2} more)`] : []),
            ].join('\n');
        });
}

/**
 * Adds the user's requests since the last scan, from every Claude and Codex session (Agent Storm's
 * and the CLIs') run inside `checkoutPath` or its worktrees, to the ledger at `ledgerPath`, then
 * writes the ledger and the checkout's recent fix commits to `digestPath` for a self-improvement
 * run to read. The ledger outlives the CLIs' own log cleanup.
 */
export async function updateFixRequestDigest({
    checkoutPath,
    ledgerPath,
    digestPath,
}: Readonly<{checkoutPath: string; ledgerPath: string; digestPath: string}>) {
    const now = Date.now();
    const retentionStart =
        now -
        convertDuration(requestRetention, {
            milliseconds: true,
        }).milliseconds;
    const ledgerContents = await readFileIfExists(ledgerPath);
    const ledger = ledgerContents
        ? wrapInTry(() => parseJsonWithShape(ledgerContents, ledgerShape), {
              fallbackValue: undefined,
          })
        : undefined;
    const window: ScanWindow = {
        folders: await listCheckoutFolders(checkoutPath),
        since: Math.max(ledger?.scannedAt ?? 0, retentionStart),
        until: now,
    };
    const [
        claudeRequests,
        codexRequests,
        fixCommits,
    ] = await Promise.all([
        readClaudeRequests(window),
        readCodexRequests(window),
        readFixCommits(checkoutPath).catch(() => []),
    ]);
    const requests = [
        ...(ledger?.requests || []),
        ...claudeRequests,
        ...codexRequests,
    ].filter((request) => request.sentAt > retentionStart);
    await writeFileAtomically({
        path: ledgerPath,
        contents: JSON.stringify({
            scannedAt: now,
            requests,
        }),
    });
    await writeFileAtomically({
        path: digestPath,
        contents: [
            '# What the user keeps fixing',
            '',
            "Generated by Agent Storm. The user's own requests to AI agents working in agent-storm, newest session first, from Agent Storm chats and the Claude and Codex CLIs, with likely secrets replaced by [redacted]. A problem that shows up across several sessions is one the user keeps having to fix.",
            '',
            '## Requests',
            '',
            ...formatRequests(requests),
            '',
            '## Recent fix commits',
            '',
            ...fixCommits,
            '',
        ].join('\n'),
    });
}
