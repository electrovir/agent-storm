import {defineConfig} from '@virmator/deps/configs/dep-cruiser.config.base.js';
import {type IConfiguration} from 'dependency-cruiser';

const baseConfig = defineConfig({
    fileExceptions: {
        // enter file exceptions by rule name here
        'no-orphans': {
            from: [
                'src/(frontend/)?index\\.ts$',
            ],
        },
        'no-circular': {
            /**
             * Lazily imports core's own frontend index to hand plugins the app's copy of it, which
             * a static import couldn't do.
             */
            from: [
                '^packages/core/src/frontend/util/plugin-registry\\.ts$',
            ],
            to: [
                '^packages/core/src/frontend/util/plugin-registry\\.ts$',
            ],
        },
        'no-deprecated-core': {
            /**
             * Node marks the whole `async_hooks` module deprecated, but the `AsyncLocalStorage` it
             * uses is stable and has no other import path.
             */
            from: [
                '^packages/agent-storm-util/src/perf-trace\\.ts$',
            ],
        },
    },
    omitRules: [
        // enter rule names here to omit
    ],
});

const depCruiserConfig: IConfiguration = {
    ...baseConfig,
    forbidden: [
        ...(baseConfig.forbidden || []),
        {
            name: 'core-only-to-common',
            comment:
                'Core is what the host and every plugin build on, so it can import neither, only common and the config library.',
            severity: 'error',
            from: {
                path: '^packages/core/',
            },
            to: {
                path: '^packages/',
                pathNot: [
                    '^packages/(common|config|core)/',
                ],
            },
        },
        {
            name: 'plugin-only-to-plugins',
            comment:
                'A plugin builds on core, common, the agent-storm-util, bot, and config libraries, and other plugins, never on the host that registers it.',
            severity: 'error',
            from: {
                path: '^packages/plugin-[^/]+/',
            },
            to: {
                path: '^packages/',
                pathNot: [
                    '^packages/(agent-storm-util|bot|common|config|core|plugin-[^/]+)/',
                ],
            },
        },
    ],
};

module.exports = depCruiserConfig;
