import {defineConfig} from '@virmator/test/configs/web-test-runner.config.base.mjs';
import {dirname} from 'path';
import {fileURLToPath, pathToFileURL} from 'url';

const baseConfig = defineConfig({
    coveragePercent: 100,
    packageRootDirPath: dirname(dirname(fileURLToPath(import.meta.url))),
    extraScreenshotOptions: {},
});

/** @type {import('@web/test-runner').TestRunnerConfig} */
const webTestRunnerConfig = {
    ...baseConfig,
    /**
     * `src/server/` runs in Node, so its tests run there through `virmator test node`. So does the
     * Viewer's Markdown test: the `development` build of micromark this runner resolves imports the
     * CommonJS `debug` package, which browsers can't load.
     */
    files: [
        baseConfig.files,
        '!src/server/**',
        '!src/util/viewer-document.test.ts',
    ].flat(),
    coverageConfig: {
        ...baseConfig.coverageConfig,
        exclude: [
            ...baseConfig.coverageConfig.exclude,
            'src/server/**',
        ],
    },
};

export default webTestRunnerConfig;

/** Log the full config if this file file is run directly as a script, for debugging. */
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    console.info(JSON.stringify(webTestRunnerConfig, null, 4));
}
