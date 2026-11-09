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
            comment: 'Core is what the host and every plugin build on, so it can import neither.',
            severity: 'error',
            from: {
                path: '^packages/core/',
            },
            to: {
                path: '^packages/',
                pathNot: [
                    '^packages/(common|core)/',
                ],
            },
        },
        {
            name: 'plugin-only-to-plugins',
            comment:
                'A plugin builds on core, common, and other plugins, never on the host that registers it.',
            severity: 'error',
            from: {
                path: '^packages/plugin-[^/]+/',
            },
            to: {
                path: '^packages/',
                pathNot: [
                    '^packages/(common|core|plugin-[^/]+)/',
                ],
            },
        },
    ],
};

module.exports = depCruiserConfig;
