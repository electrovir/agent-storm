#!/usr/bin/env node
/**
 * Reads the frontend errors log produced by the agent-storm dev server.
 *
 * The frontend's global error reporter (see packages/frontend/src/util/error-reporter.ts)
 * forwards uncaught errors, unhandled promise rejections, and console.error calls to the
 * backend, which appends them to `.logs/frontend-errors.log` at the repo root.
 *
 * Default behavior: print the last 200 lines of that log, plus a one-line liveness check
 * derived from `.logs/dev.log`. Designed to be the entire body of work for the
 * `check-frontend-errors` Claude skill — the skill should not interpret the file itself.
 */
import {existsSync, readFileSync, statSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {parseArgs} from 'node:util';

const {values} = parseArgs({
    options: {
        lines: {type: 'string', short: 'n', default: '200'},
        all: {type: 'boolean', default: false},
        grep: {type: 'string'},
        source: {type: 'string'},
        help: {type: 'boolean', short: 'h', default: false},
    },
});

if (values.help) {
    process.stdout.write(
        [
            'usage: check-frontend-errors.mjs [--lines=N] [--all] [--grep=PATTERN] [--source=NAME]',
            '',
            'Reads .logs/frontend-errors.log from the agent-storm repo root.',
            '',
            'Options:',
            '  -n, --lines N   Print the last N lines (default 200).',
            '      --all       Print the entire file (overrides --lines).',
            '      --grep P    Only print entries whose body matches the JS regex P.',
            '      --source S  Only print entries from this source',
            '                  (window.onerror | unhandledrejection | console.error | manual).',
            '',
        ].join('\n'),
    );
    process.exit(0);
}

function findRepoRoot(start) {
    let dir = resolve(start);
    while (true) {
        if (existsSync(resolve(dir, '.logs')) && existsSync(resolve(dir, 'package.json'))) {
            return dir;
        }
        const parent = dirname(dir);
        if (parent === dir) return null;
        dir = parent;
    }
}

const repoRoot = findRepoRoot(process.cwd());
if (!repoRoot) {
    process.stdout.write(
        'check-frontend-errors: could not find a repo root (looked for .logs + package.json).\n',
    );
    process.exit(2);
}

const logPath = resolve(repoRoot, '.logs/frontend-errors.log');
const devLogPath = resolve(repoRoot, '.logs/dev.log');

if (!existsSync(logPath)) {
    process.stdout.write(
        `check-frontend-errors: ${logPath} does not exist yet.\n` +
            'The dev server has not been started since the frontend error logging was wired up.\n' +
            'Run `npm start` from the repo root, reproduce the issue, then rerun this script.\n',
    );
    process.exit(0);
}

const raw = readFileSync(logPath, 'utf-8');
const size = statSync(logPath).size;

/**
 * Split the file into entries. Each entry begins with a `--- <iso> [source] ---` header line
 * appended by packages/server/src/client-errors.ts. The file also starts with a banner line
 * (`=== frontend errors @ ... ===`) that we keep as its own pseudo-entry for context.
 */
function parseEntries(text) {
    const lines = text.split('\n');
    const entries = [];
    let current = null;
    for (const line of lines) {
        const isHeader =
            line.startsWith('--- ') && line.endsWith('---') && line.includes('[');
        const isBanner = line.startsWith('=== ') && line.endsWith('===');
        if (isHeader || isBanner) {
            if (current) entries.push(current);
            const sourceMatch = isHeader ? line.match(/\[([^\]]+)\]/) : null;
            current = {
                header: line,
                source: sourceMatch ? sourceMatch[1] : isBanner ? 'banner' : 'unknown',
                body: [line],
            };
        } else if (current) {
            current.body.push(line);
        }
    }
    if (current) entries.push(current);
    return entries;
}

let entries = parseEntries(raw);

if (values.source) {
    entries = entries.filter((e) => e.source === values.source);
}

if (values.grep) {
    const pattern = new RegExp(values.grep);
    entries = entries.filter((e) => pattern.test(e.body.join('\n')));
}

const errorEntries = entries.filter((e) => e.source !== 'banner');
const banner = entries.find((e) => e.source === 'banner');

process.stdout.write(`# .logs/frontend-errors.log\n`);
process.stdout.write(`# path: ${logPath}\n`);
process.stdout.write(`# size: ${size} bytes\n`);
process.stdout.write(`# error entries (after filters): ${errorEntries.length}\n`);
if (banner) {
    process.stdout.write(`# ${banner.header}\n`);
}

if (existsSync(devLogPath)) {
    const dev = readFileSync(devLogPath, 'utf-8');
    const exitMatch = dev.match(/=== exited[^\n]*===/g);
    if (exitMatch && exitMatch.length) {
        process.stdout.write(
            `# WARNING: dev.log shows server has exited: ${exitMatch[exitMatch.length - 1]}\n`,
        );
        process.stdout.write(`# Frontend error log is stale — restart npm start.\n`);
    }
} else {
    process.stdout.write(`# WARNING: dev.log not found — dev server has never been started.\n`);
}

process.stdout.write('\n');

if (errorEntries.length === 0) {
    process.stdout.write(
        'No frontend errors recorded since the last `npm start`.\n' +
            'If you expected errors here, confirm the issue actually reproduces in the browser ' +
            'and that the dev server has restarted to pick up the latest backend code.\n',
    );
    process.exit(0);
}

let output = errorEntries.map((e) => e.body.join('\n')).join('\n');

if (!values.all) {
    const maxLines = Number.parseInt(values.lines, 10);
    if (!Number.isFinite(maxLines) || maxLines <= 0) {
        process.stderr.write(`check-frontend-errors: invalid --lines value: ${values.lines}\n`);
        process.exit(2);
    }
    const allLines = output.split('\n');
    if (allLines.length > maxLines) {
        const truncated = allLines.length - maxLines;
        output =
            `# ...truncated ${truncated} earlier line(s); pass --all or --lines=N to see more\n` +
            allLines.slice(-maxLines).join('\n');
    }
}

if (!output.endsWith('\n')) output += '\n';
process.stdout.write(output);
