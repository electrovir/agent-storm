const {baseConfig} = require('@virmator/spellcheck/configs/cspell.config.base.cjs');

module.exports = {
    ...baseConfig,
    ignorePaths: [
        ...baseConfig.ignorePaths,
        /** Prisma clients that `prisma generate` writes. */
        'packages/*/src/server/generated/',
        /** Migrations that `prisma migrate` writes. */
        'packages/*/prisma/migrations/',
        /**
         * Both are copied verbatim out of the Vir Icons VS Code extension by
         * `generate-file-icons.script.ts`: hundreds of third-party tool names as map keys, and svg
         * path data. Nothing here is hand-written, so a misspelling is not actionable.
         */
        'packages/plugin-diff/src/util/file-icon-map.generated.ts',
        'packages/frontend/www-static/file-icons/**',
    ],
    words: [
        ...baseConfig.words,
        /** Only words appearing in JSON files, which cannot carry inline `cspell:words` comments. */
        'lezer',
        'prebuilds',
        'webgl',
    ],
};
