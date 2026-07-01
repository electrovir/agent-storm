/**
 * Pre-start sanity check that fails fast when a declared workspace dependency is missing from
 * `node_modules`. Walks every workspace `package.json`, lists each non-workspace dependency, and
 * verifies it resolves to a real directory. If anything's missing, runs `npm install` to
 * reconcile rather than letting the backend crash later with an obscure `ERR_MODULE_NOT_FOUND`
 * that surfaces in the UI as "Failed to fetch".
 *
 * Designed to be the first step of `npm run init`. Fast (~50ms) when everything's already
 * installed; only triggers an install when the manifest and `node_modules` have drifted (which
 * happens routinely after a cherry-pick, pull, branch switch, or `package.json` edit).
 */
import {execSync} from 'node:child_process';
import {existsSync, readFileSync, readdirSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packagesDir = resolve(repoRoot, 'packages');

function collectDeps(pkgPath) {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    return [
        ...Object.keys(pkg.dependencies ?? {}),
        ...Object.keys(pkg.devDependencies ?? {}),
    ];
}

/**
 * Workspace packages (`@agent-storm/*`) are symlinked into `node_modules` by npm at install
 * time. They're declared as `"*"` in dependent workspaces but don't correspond to a real npm
 * package — skip them so we don't false-positive when the symlink layout is fine.
 */
function isWorkspaceDep(name) {
    return name.startsWith('@agent-storm/');
}

function depPath(name) {
    return resolve(repoRoot, 'node_modules', name, 'package.json');
}

const workspacePackages = [
    resolve(repoRoot, 'package.json'),
    ...(existsSync(packagesDir) ? readdirSync(packagesDir, {withFileTypes: true}) : [])
        .filter((entry) => entry.isDirectory())
        .map((entry) => resolve(packagesDir, entry.name, 'package.json'))
        .filter(existsSync),
];

const missing = new Set();
for (const pkgPath of workspacePackages) {
    for (const dep of collectDeps(pkgPath)) {
        if (isWorkspaceDep(dep) || existsSync(depPath(dep))) {
            continue;
        }
        missing.add(dep);
    }
}

if (missing.size === 0) {
    process.exit(0);
}

console.error(
    `agent-storm: ${missing.size} declared package(s) missing from node_modules — ` +
        `package.json and node_modules have drifted (typical after a cherry-pick, pull, ` +
        `or branch switch). Reconciling with \`npm install\`:`,
);
for (const dep of missing) {
    console.error(`  - ${dep}`);
}
execSync('npm install', {stdio: 'inherit', cwd: repoRoot});
