const {baseConfig} = require('@virmator/spellcheck/configs/cspell.config.base.cjs');

module.exports = {
    ...baseConfig,
    ignorePaths: [
        ...baseConfig.ignorePaths,
        'terminal-ui/',
    ],
    words: [
        ...baseConfig.words,
        'grabbable',
        'Menlo',
        'Meslo',
        'pid',
        'pids',
        'prebuilds',
        'toggleable',
        'webgl',
    ],
};
