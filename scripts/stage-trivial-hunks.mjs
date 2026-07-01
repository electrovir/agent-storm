#!/usr/bin/env node
/**
 * Stages hunks of unstaged changes that fit one of these "no-review-needed" categories:
 *
 *   whitespace      Pure whitespace diff (indent, blank lines, line splits, CRLF, etc.).
 *   comment         JS/TS/CSS hunks where the only difference is comment text.
 *   imports         TS/JS hunks where every +/- line is a single-line import statement —
 *                   adds, removes, reorders, or path swaps all qualify. Import-only churn
 *                   is uninteresting to review.
 *   lockfile        package-lock.json hunks, IFF a package.json change is also present
 *                   (staged or unstaged) — that means the lockfile diff is mechanical
 *                   npm-regenerated drift. A lockfile-only change with no package.json
 *                   movement is suspicious and stays out for manual review.
 *   css             Any hunk in a *.css file — visual-only by definition.
 *   tests           Any hunk in a *.test.ts file — test-only changes don't need review.
 *   translations    Any hunk in a `src/data/translations/{en,es,tl}.ts` file — generated/
 *                   translated strings the user explicitly doesn't review.
 *
 * Always skips new files, deleted files, renames/copies, and binary files. The judgement
 * "this didn't need review" doesn't really apply to whole-file additions/removals.
 *
 * Designed to be the entire body of work for the `stage-trivial-changes` skill — the skill
 * just invokes this and reports the output.
 */
import {execFileSync, spawnSync} from 'node:child_process';
import {parseArgs} from 'node:util';

const CATEGORIES = ['whitespace', 'comment', 'imports', 'lockfile', 'css', 'tests', 'translations'];

const {values} = parseArgs({
    options: {
        'dry-run': {type: 'boolean', default: false},
        only: {type: 'string'},
        exclude: {type: 'string'},
        help: {type: 'boolean', short: 'h', default: false},
    },
});

if (values.help) {
    process.stdout.write(usage());
    process.exit(0);
}

function usage() {
    return [
        'usage: stage-trivial-hunks.mjs [--dry-run] [--only=A,B] [--exclude=A,B]',
        '',
        'Categories (all enabled by default):',
        '  whitespace      Pure whitespace differences.',
        '  comment         JS/TS/CSS comment-only changes.',
        '  imports         TS/JS hunks where every +/- line is a single-line import.',
        '  lockfile        package-lock.json hunks when package.json is also dirty.',
        '  css             Any hunk in a .css file.',
        '  tests           Any hunk in a .test.ts file.',
        '  translations    Any hunk in src/data/translations/{en,es,tl}.ts.',
        '',
        'Options:',
        '  --dry-run       Print the patch but do not stage it.',
        '  --only=LIST     Comma-separated allowlist of categories.',
        '  --exclude=LIST  Comma-separated denylist of categories.',
        '',
    ].join('\n');
}

function parseList(s) {
    return s.split(',').map((x) => x.trim()).filter(Boolean);
}

const requestedOnly = values.only ? parseList(values.only) : null;
const requestedExclude = values.exclude ? parseList(values.exclude) : [];
for (const c of [...(requestedOnly ?? []), ...requestedExclude]) {
    if (!CATEGORIES.includes(c)) {
        process.stderr.write(`Unknown category: ${c}\nKnown: ${CATEGORIES.join(', ')}\n`);
        process.exit(2);
    }
}
const allowed = new Set(requestedOnly ?? CATEGORIES);
for (const c of requestedExclude) allowed.delete(c);

function git(args, options = {}) {
    return execFileSync('git', args, {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        ...options,
    });
}

const repoRoot = git(['rev-parse', '--show-toplevel']).trim();

function anyPackageJsonChanged() {
    const lists = [
        git(['diff', '--name-only'], {cwd: repoRoot}),
        git(['diff', '--cached', '--name-only'], {cwd: repoRoot}),
    ];
    for (const out of lists) {
        for (const line of out.split('\n')) {
            if (/(^|\/)package\.json$/.test(line)) return true;
        }
    }
    return false;
}

const packageJsonDirty = anyPackageJsonChanged();

const diffOutput = git(['diff', '--no-color', '--no-ext-diff', '-U0'], {cwd: repoRoot});

if (!diffOutput.trim()) {
    process.stdout.write('No unstaged changes.\n');
    process.exit(0);
}

function parseDiff(diff) {
    const lines = diff.split('\n');
    const files = [];
    let i = 0;

    while (i < lines.length) {
        if (!lines[i].startsWith('diff --git ')) {
            i++;
            continue;
        }

        const file = {
            preHunkLines: [lines[i]],
            hunks: [],
            skipReason: null,
            path: null,
        };
        i++;

        while (
            i < lines.length
            && !lines[i].startsWith('@@ ')
            && !lines[i].startsWith('diff --git ')
        ) {
            const line = lines[i];
            file.preHunkLines.push(line);
            if (line.startsWith('Binary files ')) file.skipReason = 'binary';
            else if (line.startsWith('new file mode')) file.skipReason = 'new file';
            else if (line.startsWith('deleted file mode')) file.skipReason = 'deleted file';
            else if (line.startsWith('rename ') || line.startsWith('copy ')) {
                file.skipReason = 'rename/copy';
            }
            if (line.startsWith('--- a/')) file.path = line.slice(6);
            else if (line.startsWith('+++ b/') && !file.path) file.path = line.slice(6);
            i++;
        }

        while (i < lines.length && lines[i].startsWith('@@ ')) {
            const hunk = {header: lines[i], lines: []};
            i++;
            while (
                i < lines.length
                && !lines[i].startsWith('@@ ')
                && !lines[i].startsWith('diff --git ')
            ) {
                hunk.lines.push(lines[i]);
                i++;
            }
            file.hunks.push(hunk);
        }

        files.push(file);
    }

    return files;
}

function fileExt(path) {
    if (!path) return '';
    const m = /\.([^./\\]+)$/.exec(path);
    return m ? '.' + m[1] : '';
}

function fileBasename(path) {
    return path ? path.split('/').pop() : '';
}

const JS_TS_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

// ===== whitespace =====

function isWhitespaceOnly(hunk) {
    let removed = '';
    let added = '';
    let hasChange = false;
    for (const line of hunk.lines) {
        if (line.startsWith('-')) {
            removed += line.slice(1);
            hasChange = true;
        } else if (line.startsWith('+')) {
            added += line.slice(1);
            hasChange = true;
        }
    }
    if (!hasChange) return false;
    return removed.replace(/\s+/g, '') === added.replace(/\s+/g, '');
}

// ===== comment =====

function stripJsLineComment(line) {
    // Walk the string and chop at the first `//` that isn't inside a quoted string.
    // Misses regex literals, but staging a mis-classified hunk would require a contrived case.
    let inStr = null;
    let backslash = false;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (backslash) {
            backslash = false;
            continue;
        }
        if (c === '\\') {
            backslash = true;
            continue;
        }
        if (inStr) {
            if (c === inStr) inStr = null;
            continue;
        }
        if (c === '"' || c === "'" || c === '`') {
            inStr = c;
            continue;
        }
        if (c === '/' && line[i + 1] === '/') return line.slice(0, i);
    }
    return line;
}

function stripInlineBlockComments(line) {
    return line.replace(/\/\*[^]*?\*\//g, '');
}

function stripComments(line, ext) {
    if (JS_TS_EXTS.has(ext)) {
        return stripJsLineComment(stripInlineBlockComments(line));
    }
    if (ext === '.css') {
        return stripInlineBlockComments(line);
    }
    return line;
}

function isPureCommentLine(content, ext) {
    const t = content.trim();
    if (t === '') return true;
    if (JS_TS_EXTS.has(ext)) {
        return t.startsWith('//')
            || t.startsWith('/*')
            || t.startsWith('*/')
            || t.startsWith('*');
    }
    if (ext === '.css') {
        return t.startsWith('/*') || t.startsWith('*/') || t.startsWith('*');
    }
    return false;
}

function isCommentOnly(hunk, file) {
    const ext = fileExt(file.path);
    if (!JS_TS_EXTS.has(ext) && ext !== '.css') return false;

    const changes = hunk.lines.filter((l) => l.startsWith('+') || l.startsWith('-'));
    if (changes.length === 0) return false;

    if (changes.every((l) => isPureCommentLine(l.slice(1), ext))) return true;

    let removed = '';
    let added = '';
    let anyCommentSeen = false;
    for (const line of changes) {
        const content = line.slice(1);
        const stripped = stripComments(content, ext);
        if (stripped !== content) anyCommentSeen = true;
        if (line.startsWith('-')) removed += stripped + '\n';
        else added += stripped + '\n';
    }
    if (!anyCommentSeen) return false;
    return removed.replace(/\s+/g, '') === added.replace(/\s+/g, '');
}

// ===== imports =====

const IMPORT_STATEMENT_RX = /^import\b[\s\S]*['"][^'"]+['"]$/;

/**
 * Split a chunk of source text into logical statements. A statement ends at the first `;`
 * (or newline, ASI-style) encountered *outside* of `{ }` braces and string literals. That
 * lets a multi-line `import { ... } from 'x';` reduce to one statement while keeping
 * top-level statements separate.
 */
function splitStatements(text) {
    const out = [];
    let current = '';
    let braceDepth = 0;
    let inString = null;
    let backslash = false;
    const flushIfNonEmpty = () => {
        const trimmed = current.trim();
        if (trimmed) out.push(trimmed);
        current = '';
    };
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (backslash) {
            backslash = false;
            current += c;
            continue;
        }
        if (inString) {
            current += c;
            if (c === '\\') backslash = true;
            else if (c === inString) inString = null;
            continue;
        }
        if (c === '"' || c === "'" || c === '`') {
            inString = c;
            current += c;
            continue;
        }
        if (c === '{') braceDepth++;
        else if (c === '}') braceDepth = Math.max(0, braceDepth - 1);
        if (braceDepth === 0 && (c === ';' || c === '\n')) {
            if (c === ';') current += c;
            flushIfNonEmpty();
            continue;
        }
        current += c;
    }
    flushIfNonEmpty();
    return out;
}

/**
 * True iff every non-empty statement in the text is an `import …'path'` form. Whitespace
 * inside the statement (including line breaks for multi-line `import { … } from '…';`) is
 * collapsed before the import regex runs.
 */
function looksLikeImportsOnly(text) {
    const statements = splitStatements(text);
    if (statements.length === 0) return true;
    for (const stmt of statements) {
        const flat = stmt.replace(/\s+/g, ' ').trim().replace(/;$/, '');
        if (!IMPORT_STATEMENT_RX.test(flat)) return false;
    }
    return true;
}

function isImportsOnly(hunk, file) {
    const ext = fileExt(file.path);
    if (!JS_TS_EXTS.has(ext)) return false;

    let plus = '';
    let minus = '';
    let hasChange = false;
    for (const line of hunk.lines) {
        if (line.startsWith('+')) {
            plus += line.slice(1) + '\n';
            hasChange = true;
        } else if (line.startsWith('-')) {
            minus += line.slice(1) + '\n';
            hasChange = true;
        }
    }
    if (!hasChange) return false;
    return looksLikeImportsOnly(plus) && looksLikeImportsOnly(minus);
}

// ===== lockfile =====

function isLockfileHunk(_hunk, file) {
    if (fileBasename(file.path) !== 'package-lock.json') return false;
    // Only stage lockfile churn when a package.json change is also present — that means
    // the lockfile diff is mechanical npm-regenerated drift, not something to review.
    return packageJsonDirty;
}

// ===== css =====

function isCssHunk(_hunk, file) {
    return fileExt(file.path) === '.css';
}

// ===== tests =====

function isTestHunk(_hunk, file) {
    return !!file.path && /\.test\.ts$/.test(file.path);
}

// ===== translations =====

// Matches paths whose tail is `src/data/translations/<lang>.ts` for languages the user
// doesn't review by hand. Anchored on `/` so a file like `not-src/data/translations/en.ts`
// (unlikely but possible) doesn't match by accident.
const TRANSLATIONS_RX = /(^|\/)src\/data\/translations\/(en|es|tl)\.ts$/;

function isTranslationHunk(_hunk, file) {
    return !!file.path && TRANSLATIONS_RX.test(file.path);
}

// ===== dispatch =====

const DETECTORS = [
    {name: 'whitespace', match: (h, f) => isWhitespaceOnly(h, f)},
    {name: 'comment', match: (h, f) => isCommentOnly(h, f)},
    {name: 'imports', match: (h, f) => isImportsOnly(h, f)},
    {name: 'lockfile', match: (h, f) => isLockfileHunk(h, f)},
    {name: 'css', match: (h, f) => isCssHunk(h, f)},
    {name: 'tests', match: (h, f) => isTestHunk(h, f)},
    {name: 'translations', match: (h, f) => isTranslationHunk(h, f)},
];

function categorize(hunk, file) {
    for (const d of DETECTORS) {
        if (!allowed.has(d.name)) continue;
        if (d.match(hunk, file)) return d.name;
    }
    return null;
}

const files = parseDiff(diffOutput);

const matches = [];
const skipped = [];

for (const file of files) {
    if (file.skipReason) {
        if (file.path) skipped.push({path: file.path, reason: file.skipReason});
        continue;
    }
    const hunks = [];
    for (const hunk of file.hunks) {
        const cat = categorize(hunk, file);
        if (cat) hunks.push({hunk, category: cat});
    }
    if (hunks.length) matches.push({file, hunks});
}

if (matches.length === 0) {
    process.stdout.write('No trivial hunks found in unstaged changes.\n');
    if (!packageJsonDirty && allowed.has('lockfile')) {
        process.stdout.write(
            '\nNote: package.json is clean, so package-lock.json hunks were left for manual review.\n',
        );
    }
    if (skipped.length) {
        process.stdout.write('\nSkipped (not eligible):\n');
        for (const s of skipped) process.stdout.write(`  ${s.path} (${s.reason})\n`);
    }
    process.exit(0);
}

process.stdout.write('Trivial hunks:\n');
for (const {file, hunks} of matches) {
    const counts = {};
    for (const {category} of hunks) counts[category] = (counts[category] || 0) + 1;
    const summary = Object.entries(counts)
        .map(([c, n]) => `${n} ${c}`)
        .join(', ');
    process.stdout.write(`  ${file.path}: ${summary}\n`);
}
if (!packageJsonDirty && allowed.has('lockfile')) {
    process.stdout.write(
        '\nNote: package.json is clean, so package-lock.json hunks were left for manual review.\n',
    );
}
if (skipped.length) {
    process.stdout.write('\nSkipped (not eligible):\n');
    for (const s of skipped) process.stdout.write(`  ${s.path} (${s.reason})\n`);
}

const patch = matches
    .map(({file, hunks}) => {
        const parts = [...file.preHunkLines];
        for (const {hunk} of hunks) {
            parts.push(hunk.header);
            parts.push(...hunk.lines);
        }
        return parts.join('\n') + '\n';
    })
    .join('');

if (values['dry-run']) {
    process.stdout.write('\n--- patch (dry-run, not applied) ---\n');
    process.stdout.write(patch);
    process.exit(0);
}

const result = spawnSync(
    'git',
    ['apply', '--cached', '--unidiff-zero', '--whitespace=nowarn', '-'],
    {input: patch, cwd: repoRoot, encoding: 'utf8'},
);

if (result.status !== 0) {
    process.stderr.write('\ngit apply --cached failed:\n');
    if (result.stderr) process.stderr.write(result.stderr);
    process.stderr.write('\nPatch that failed to apply:\n');
    process.stderr.write(patch);
    process.exit(1);
}

const total = matches.reduce((n, m) => n + m.hunks.length, 0);
const byCat = {};
for (const m of matches) {
    for (const h of m.hunks) byCat[h.category] = (byCat[h.category] || 0) + 1;
}
const catSummary = Object.entries(byCat)
    .map(([c, n]) => `${n} ${c}`)
    .join(', ');
process.stdout.write(
    `\nStaged ${total} hunk(s) across ${matches.length} file(s): ${catSummary}.\n`,
);
