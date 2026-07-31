const {baseConfig} = require('@virmator/spellcheck/configs/cspell.config.base.cjs');

module.exports = {
    ...baseConfig,
    ignorePaths: [
        ...baseConfig.ignorePaths,
    ],
    words: [
        ...baseConfig.words,
        /** Only words appearing in JSON files, which cannot carry inline `cspell:words` comments. */
        'prebuilds',
        'webgl',
    ],
};
