import {readReleaseCoreVersion} from 'agent-storm';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {assertValidShape, defineShape} from 'object-shape-tester';
import {monorepoRoot, releaseRootDir} from './file-paths.js';
import {releaseBuild} from './release-build.js';

const packageVersionShape = defineShape({
    version: '',
});

async function readCoreVersion() {
    if (releaseBuild) {
        const releaseCoreVersion = await readReleaseCoreVersion(releaseRootDir);
        if (!releaseCoreVersion) {
            throw new Error(`The running release ${releaseRootDir} records no core version.`);
        }
        return releaseCoreVersion;
    }
    const packageJson: unknown = JSON.parse(
        await readFile(resolve(monorepoRoot, 'packages', 'core', 'package.json'), 'utf8'),
    );
    assertValidShape(packageJson, packageVersionShape, {
        allowExtraKeys: true,
    });
    return packageJson.version;
}

const coreVersionCache: {version: Promise<string> | undefined} = {
    version: undefined,
};

/** The `@agent-storm/core` version the running app supplies to plugins. */
export async function readRunningCoreVersion() {
    coreVersionCache.version ??= readCoreVersion();
    return await coreVersionCache.version;
}
