import {
    agentLaunchScriptPath,
    claudeHookSourceDir,
    daemonScriptPath,
    monorepoRoot,
} from '@agent-storm/server/src/file-paths.js';
import {releaseBuildGlobalName} from '@agent-storm/server/src/release-build.js';
import {extractExtension, log} from '@augment-vir/common';
import {runShellCommand} from '@augment-vir/node';
import {releaseAssetName, ReleaseDir} from 'agent-storm';
import {build} from 'esbuild';
import {cp, mkdir, readdir, readFile, rm, writeFile} from 'node:fs/promises';
import {basename, resolve} from 'node:path';
import {assertValidShape, defineShape} from 'object-shape-tester';

/**
 * Builds a release into `dist-release/`: the frontend, the server and the scripts it spawns bundled
 * into plain JavaScript, and a `package.json` whose only dependency is node-pty, which can't be
 * bundled because it's native. Then packs it into `dist-release-asset/`, ready to attach to a
 * GitHub release.
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
    releaseBuild,
] = await Promise.all([
    readPackageVersion(resolve(monorepoRoot, 'node_modules', 'node-pty')),
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
const markdownFileNames = (await readdir(serverSourceDir)).filter(
    (fileName) => extractExtension(fileName).extension === '.md',
);
await Promise.all([
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
