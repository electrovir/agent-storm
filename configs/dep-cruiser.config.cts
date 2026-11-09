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
            name: 'plugin-only-to-core',
            comment:
                'A plugin builds only on core and common, so the host can register any set of plugins. Move code two plugins share into core.',
            severity: 'error',
            from: {
                path: '^packages/(?!common/|core/|frontend/|scripts/|server/)([^/]+)/',
            },
            to: {
                path: '^packages/',
                pathNot: [
                    '^packages/(common|core|$1)/',
                ],
            },
        },
    ],
};

module.exports = depCruiserConfig;
