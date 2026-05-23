const {baseConfig} = require('@virmator/spellcheck/configs/cspell.config.base.cjs');

module.exports = {
    ...baseConfig,
    ignorePaths: [
        ...baseConfig.ignorePaths,
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
