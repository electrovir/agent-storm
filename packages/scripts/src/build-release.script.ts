import {daemonProtocolVersion} from '@agent-storm/server/src/daemon/protocol.js';
import {
    agentLaunchScriptPath,
    claudeHookSourceDir,
    daemonScriptPath,
    monorepoRoot,
} from '@agent-storm/server/src/file-paths.js';
import {releaseBuildGlobalName} from '@agent-storm/server/src/release-build.js';
import {extractExtension, log} from '@augment-vir/common';
import {runShellCommand} from '@augment-vir/node';
import {
    releaseAssetName,
    ReleaseDir,
    writeReleaseCoreVersion,
    writeReleaseDaemonProtocolVersion,
} from 'agent-storm';
import {build} from 'esbuild';
import {cp, mkdir, readdir, readFile, rm, writeFile} from 'node:fs/promises';
import {basename, resolve} from 'node:path';
import {assertValidShape, defineShape} from 'object-shape-tester';
import {buildBuiltInPlugins} from './built-in-plugin-build.js';

/**
 * Builds a release into `dist-release/`: the frontend, the server and the scripts it spawns bundled
 * into plain JavaScript, each built-in plugin's folder, and a `package.json` listing the
 * dependencies the bundles leave out: the native node-pty and better-sqlite3, and the Claude Agent
 * SDK, which runs a platform-specific Claude Code binary. Then packs it into `dist-release-asset/`,
 * ready to attach to a GitHub release.
 */

const releaseDir = resolve(monorepoRoot, 'dist-release');
const assetDir = resolve(monorepoRoot, 'dist-release-asset');
const serverOutDir = resolve(releaseDir, ReleaseDir.Server);
const serverSourceDir = resolve(monorepoRoot, 'packages', 'server', 'src');

const packageVersionShape = defineShape({
    version: '',
});

async function readPackageVersion(packageDir: string) {
    const packageJson: unknown = JSON.parse(
        await readFile(resolve(packageDir, 'package.json'), 'utf8'),
    );
    assertValidShape(packageJson, packageVersionShape, {
        allowExtraKeys: true,
    });
    return packageJson.version;
}

/** The release the current checkout builds, from its git tags and commit. */
async function readReleaseBuild() {
    const [
        versionOutput,
        commitOutput,
    ] = await Promise.all([
        runShellCommand('git describe --tags --always', {
            cwd: monorepoRoot,
            rejectOnError: true,
        }),
        runShellCommand('git rev-parse HEAD', {
            cwd: monorepoRoot,
            rejectOnError: true,
        }),
    ]);
    return {
        version: versionOutput.stdout.trim(),
        commit: commitOutput.stdout.trim(),
    };
}

const [
    nodePtyVersion,
    betterSqliteVersion,
    claudeAgentSdkVersion,
    coreVersion,
    releaseBuild,
] = await Promise.all([
    readPackageVersion(resolve(monorepoRoot, 'node_modules', 'node-pty')),
    readPackageVersion(resolve(monorepoRoot, 'node_modules', 'better-sqlite3')),
    readPackageVersion(resolve(monorepoRoot, 'node_modules', '@anthropic-ai', 'claude-agent-sdk')),
    readPackageVersion(resolve(monorepoRoot, 'packages', 'core')),
    readReleaseBuild(),
]);

await Promise.all(
    [
        releaseDir,
        assetDir,
    ].map(async (dir) => {
        await rm(dir, {
            recursive: true,
            force: true,
        });
    }),
);

await runShellCommand(
    `npx vite build --config configs/vite.config.ts --outDir ${JSON.stringify(resolve(releaseDir, ReleaseDir.Frontend))} --emptyOutDir`,
    {
        cwd: resolve(monorepoRoot, 'packages', 'frontend'),
        env: {
            ...process.env,
            /** Node can't strip types from virmator's `.ts` base config inside `node_modules`. */
            NODE_OPTIONS: '--import tsx',
            /** Virmator's config serves from a GitHub Pages subpath when `CI` is set. */
            CI: '',
            /** Without a backend port, the frontend talks to the server that served it. */
            BACKEND_PORT: '',
        },
        rejectOnError: true,
        hookUpToConsole: true,
    },
);

await build({
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    external: [
        'node-pty',
        /**
         * `@rest-vir/host`'s index re-exports its test helpers, which reach Playwright through
         * `@augment-vir/test`. The server never calls them, so they're dropped from the bundle, but
         * esbuild still has to resolve them first and can't resolve Playwright's optional imports.
         */
        'playwright-core',
        'chromium-bidi',
    ],
    define: {
        [releaseBuildGlobalName]: JSON.stringify(releaseBuild),
    },
    logLevel: 'warning',
    entryPoints: [
        resolve(serverSourceDir, 'index.ts'),
        resolve(serverSourceDir, 'launcher', 'launcher.ts'),
        daemonScriptPath,
        agentLaunchScriptPath,
    ],
    entryNames: '[name]',
    outdir: serverOutDir,
    banner: {
        /** Bundled CommonJS dependencies `require` Node's built-ins, which ES modules lack. */
        js: "import {createRequire} from 'node:module'; const require = createRequire(import.meta.url);",
    },
});
if (
    !(await buildBuiltInPlugins({
        findOutDir(pluginId) {
            return resolve(releaseDir, ReleaseDir.Plugins, pluginId);
        },
    }))
) {
    throw new Error('A built-in plugin failed to build. Its errors are logged above.');
}
const markdownFileNames = (await readdir(serverSourceDir)).filter(
    (fileName) => extractExtension(fileName).extension === '.md',
);
await Promise.all([
    writeReleaseCoreVersion({
        releaseDir,
        coreVersion,
    }),
    writeReleaseDaemonProtocolVersion({
        releaseDir,
        daemonProtocolVersion,
    }),
    cp(claudeHookSourceDir, resolve(serverOutDir, basename(claudeHookSourceDir)), {
        recursive: true,
    }),
    ...markdownFileNames.map(async (fileName) => {
        await cp(resolve(serverSourceDir, fileName), resolve(serverOutDir, fileName));
    }),
    writeFile(
        resolve(releaseDir, 'package.json'),
        `${JSON.stringify(
            {
                name: 'agent-storm-release',
                private: true,
                type: 'module',
                dependencies: {
                    'node-pty': nodePtyVersion,
                    'better-sqlite3': betterSqliteVersion,
                    '@anthropic-ai/claude-agent-sdk': claudeAgentSdkVersion,
                },
            },
            undefined,
            4,
        )}\n`,
    ),
]);

await runShellCommand('npm install --package-lock-only --ignore-scripts', {
    cwd: releaseDir,
    rejectOnError: true,
    hookUpToConsole: true,
});

await mkdir(assetDir);
await runShellCommand(
    `tar -czf ${JSON.stringify(resolve(assetDir, releaseAssetName))} -C ${JSON.stringify(releaseDir)} .`,
    {
        rejectOnError: true,
    },
);

log.success(
    `Built agent-storm ${releaseBuild.version} (${releaseBuild.commit}) into ${releaseDir} and ${assetDir}`,
);
