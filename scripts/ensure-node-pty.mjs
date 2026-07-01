#!/usr/bin/env node
import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const ptyDir = join(repoRoot, 'node_modules', 'node-pty');

const candidates = [
    join(ptyDir, 'build', 'Release', 'pty.node'),
    join(ptyDir, 'build', 'Debug', 'pty.node'),
    join(ptyDir, 'prebuilds', `${process.platform}-${process.arch}`, 'pty.node'),
];

if (candidates.some(existsSync)) {
    process.exit(0);
}

console.log(`node-pty native module missing for ${process.platform}-${process.arch}; rebuilding...`);
const result = spawnSync('npm', ['rebuild', 'node-pty'], {
    cwd: repoRoot,
    stdio: 'inherit',
});
if (result.status !== 0) {
    process.exit(result.status ?? 1);
}
// `npm rebuild` can exit 0 without producing the binary (e.g. when it decides
// nothing needs doing). Verify the native module actually exists now.
if (!candidates.some(existsSync)) {
    console.error(
        `node-pty rebuild reported success but no native module was produced. Checked:\n  ${candidates.join('\n  ')}`,
    );
    process.exit(1);
}
process.exit(0);
