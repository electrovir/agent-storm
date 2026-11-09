import {createCuid2} from '@augment-vir/common';
import {currentOperatingSystem, OperatingSystem, readFileIfExists} from '@augment-vir/node';
import {convertDuration} from 'date-vir';
import {createHash} from 'node:crypto';
import {access, mkdir, rename, rm, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {defineShape, nullableShape, optionalShape, parseJsonWithShape} from 'object-shape-tester';
import {buildUrl} from 'url-vir';
import {releaseAssetName} from './release-layout.js';
import {runCommand} from './run-command.js';
import {makeSpawnHelpersExecutable} from './spawn-helper.js';
import {writeFileAtomically} from './write-file-atomically.js';

/** Release tags double as folder names, so anything else is refused before it touches a path. */
const versionPattern = /^v\d+\.\d+\.\d+$/;

/**
 * Whether `version` names a release, such as `v1.10.1`.
 *
 * @category Util
 */
export function isReleaseVersion(version: string) {
    return versionPattern.test(version);
}

function assertValidVersion(version: string) {
    if (!isReleaseVersion(version)) {
        throw new Error(`"${version}" is not an agent-storm release version, such as "v1.10.1".`);
    }
}

function toVersionParts(version: string) {
    assertValidVersion(version);
    return version.slice(1).split('.').map(Number);
}

/**
 * Compares release versions by their numbers, so `v1.10.0` is newer than `v1.9.0`.
 *
 * @category Util
 */
export function isNewerVersion({version, than}: Readonly<{version: string; than: string}>) {
    const thanParts = toVersionParts(than);
    const difference = toVersionParts(version)
        .map((part, index) => part - (thanParts[index] ?? 0))
        .find((partDifference) => partDifference !== 0);
    return (difference ?? 0) > 0;
}

/**
 * Where `version` is installed inside `versionsDir`.
 *
 * @category Util
 */
export function getVersionDir({
    versionsDir,
    version,
}: Readonly<{versionsDir: string; version: string}>) {
    assertValidVersion(version);
    return resolve(versionsDir, version);
}

async function exists(path: string) {
    try {
        await access(path);
        return true;
    } catch {
        return false;
    }
}

const activeVersionsShape = defineShape({
    active: '',
    /** The version that was active before `active`, to roll back to. */
    previous: optionalShape('', {
        alsoUndefined: true,
    }),
    /** A version that failed to start, which is not offered as an update again. */
    rejected: optionalShape('', {
        alsoUndefined: true,
    }),
});

/**
 * The installed versions: the one that runs, the one to roll back to, and the one that failed.
 *
 * @category Internal
 */
export type ActiveVersions = typeof activeVersionsShape.runtimeType;

function getActiveVersionsPath(versionsDir: string) {
    return resolve(versionsDir, 'active.json');
}

/**
 * `undefined` until a version is first activated.
 *
 * @category Util
 */
export async function readActiveVersions(versionsDir: string) {
    const contents = await readFileIfExists(getActiveVersionsPath(versionsDir));
    return contents == undefined ? undefined : parseJsonWithShape(contents, activeVersionsShape);
}

/**
 * Makes an installed `version` the active one, keeping the active version it replaces as the one to
 * roll back to. Activating the version that is already active changes nothing.
 *
 * @category Util
 */
export async function activateVersion({
    versionsDir,
    version,
}: Readonly<{versionsDir: string; version: string}>) {
    if (
        !(await exists(
            getVersionDir({
                versionsDir,
                version,
            }),
        ))
    ) {
        throw new Error(`Cannot activate agent-storm ${version}: it isn't installed.`);
    }
    const current = await readActiveVersions(versionsDir);
    if (current?.active === version) {
        return;
    }
    await writeActiveVersions({
        versionsDir,
        activeVersions: {
            active: version,
            previous: current?.active,
            rejected: current?.rejected === version ? undefined : current?.rejected,
        },
    });
}

/**
 * Marks `version` as failing to start, so it isn't offered as an update again. Rejecting the active
 * version makes the previous version active.
 *
 * @category Util
 */
export async function rejectVersion({
    versionsDir,
    version,
}: Readonly<{versionsDir: string; version: string}>) {
    const current = await readActiveVersions(versionsDir);
    if (!current) {
        throw new Error(`Cannot reject agent-storm ${version}: no version is active.`);
    } else if (current.active !== version) {
        await writeActiveVersions({
            versionsDir,
            activeVersions: {
                ...current,
                rejected: version,
            },
        });
        return;
    } else if (!current.previous) {
        throw new Error(
            `Cannot reject agent-storm ${version}: no previous version to fall back to.`,
        );
    }
    await writeActiveVersions({
        versionsDir,
        activeVersions: {
            active: current.previous,
            rejected: version,
        },
    });
}

async function writeActiveVersions({
    versionsDir,
    activeVersions,
}: Readonly<{versionsDir: string; activeVersions: Readonly<ActiveVersions>}>) {
    await writeFileAtomically({
        path: getActiveVersionsPath(versionsDir),
        contents: `${JSON.stringify(activeVersions, undefined, 4)}\n`,
    });
}

/** Windows can only run `npm`, a `.cmd` script, through a shell. */
const needsShellForNpm = {
    [OperatingSystem.Linux]: false,
    [OperatingSystem.Mac]: false,
    [OperatingSystem.Windows]: true,
} satisfies Record<OperatingSystem, boolean>;

/**
 * Installs a release tarball as `version`, ready to run. A version that is already installed is
 * left as it is. The install is staged in a sibling folder and renamed into place, so a failed or
 * interrupted install never looks installed.
 *
 * @category Util
 */
export async function installVersion({
    versionsDir,
    version,
    tarballPath,
}: Readonly<{versionsDir: string; version: string; tarballPath: string}>) {
    const versionDir = getVersionDir({
        versionsDir,
        version,
    });
    if (await exists(versionDir)) {
        return versionDir;
    }
    const stagingDir = resolve(versionsDir, `.installing-${version}-${createCuid2()}`);
    await mkdir(stagingDir, {
        recursive: true,
    });
    try {
        await runCommand(
            'tar',
            [
                '-xzf',
                tarballPath,
                '-C',
                stagingDir,
            ],
            {
                timeout: {
                    minutes: 2,
                },
            },
        );
        await runCommand(
            'npm',
            [
                'ci',
                '--omit=dev',
            ],
            {
                cwd: stagingDir,
                shell: needsShellForNpm[currentOperatingSystem],
                timeout: {
                    minutes: 10,
                },
            },
        );
        await makeSpawnHelpersExecutable(
            resolve(stagingDir, 'node_modules', 'node-pty', 'prebuilds'),
        );
        await rename(stagingDir, versionDir);
    } catch (error) {
        await rm(stagingDir, {
            recursive: true,
            force: true,
        });
        throw error;
    }
    return versionDir;
}

const releasesRepo = {
    owner: 'electrovir',
    name: 'agent-storm',
};

/** Identifies these requests to GitHub, which rejects API requests that have no user agent. */
const userAgent = 'agent-storm-updater';

async function fetchReleasesApi(paths: ReadonlyArray<string>) {
    return await fetch(
        buildUrl('https://api.github.com', {
            paths: [
                'repos',
                releasesRepo.owner,
                releasesRepo.name,
                'releases',
                ...paths,
            ],
        }).href,
        {
            headers: {
                accept: 'application/vnd.github+json',
                'user-agent': userAgent,
            },
            signal: AbortSignal.timeout(
                convertDuration(
                    {
                        seconds: 30,
                    },
                    {
                        milliseconds: true,
                    },
                ).milliseconds,
            ),
        },
    );
}

const latestReleaseShape = defineShape({
    tag_name: '',
});

/**
 * The newest published release's version.
 *
 * @category Util
 */
export async function fetchLatestVersion() {
    const response = await fetchReleasesApi([
        'latest',
    ]);
    if (!response.ok) {
        throw new Error(
            `Failed to look up the latest agent-storm release: HTTP ${response.status}.`,
        );
    }
    const {tag_name: version} = parseJsonWithShape(await response.text(), latestReleaseShape, {
        allowExtraKeys: true,
    });
    assertValidVersion(version);
    return version;
}

const releaseAssetsShape = defineShape({
    immutable: nullableShape(false),
    assets: [
        {
            name: '',
            digest: nullableShape(''),
        },
    ],
});

/**
 * The SHA-256 GitHub recorded for `version`'s release asset. Only an immutable release counts: its
 * asset can't be replaced after publishing, so the recorded hash is the one the release workflow
 * uploaded.
 */
async function fetchReleaseAssetSha256(version: string) {
    const response = await fetchReleasesApi([
        'tags',
        version,
    ]);
    if (!response.ok) {
        throw new Error(`Failed to look up agent-storm ${version}: HTTP ${response.status}.`);
    }
    const release = parseJsonWithShape(await response.text(), releaseAssetsShape, {
        allowExtraKeys: true,
    });
    if (!release.immutable) {
        throw new Error(
            `agent-storm ${version} is not an immutable release, so it is not installed.`,
        );
    }
    const digest = release.assets.find((asset) => asset.name === releaseAssetName)?.digest || '';
    const sha256 = /^sha256:([0-9a-f]{64})$/.exec(digest)?.[1];
    if (!sha256) {
        throw new Error(`agent-storm ${version} has no SHA-256 digest for ${releaseAssetName}.`);
    }
    return sha256;
}

/**
 * Downloads `version`'s release from GitHub and installs it, as {@link installVersion}.
 *
 * @category Util
 */
export async function installRelease({
    versionsDir,
    version,
}: Readonly<{versionsDir: string; version: string}>) {
    assertValidVersion(version);
    const tarballPath = resolve(versionsDir, `.download-${version}-${createCuid2()}.tgz`);
    await mkdir(versionsDir, {
        recursive: true,
    });
    try {
        const expectedSha256 = await fetchReleaseAssetSha256(version);
        const response = await fetch(
            buildUrl('https://github.com', {
                paths: [
                    releasesRepo.owner,
                    releasesRepo.name,
                    'releases',
                    'download',
                    version,
                    releaseAssetName,
                ],
            }).href,
            {
                headers: {
                    'user-agent': userAgent,
                },
                signal: AbortSignal.timeout(
                    convertDuration(
                        {
                            minutes: 5,
                        },
                        {
                            milliseconds: true,
                        },
                    ).milliseconds,
                ),
            },
        );
        if (!response.ok) {
            throw new Error(`Failed to download agent-storm ${version}: HTTP ${response.status}.`);
        }
        const tarball = Buffer.from(await response.arrayBuffer());
        const actualSha256 = createHash('sha256').update(tarball).digest('hex');
        if (actualSha256 !== expectedSha256) {
            throw new Error(
                `agent-storm ${version} download doesn't match its release's SHA-256, so it is not installed.`,
            );
        }
        await writeFile(tarballPath, tarball);
        return await installVersion({
            versionsDir,
            version,
            tarballPath,
        });
    } finally {
        await rm(tarballPath, {
            force: true,
        });
    }
}
