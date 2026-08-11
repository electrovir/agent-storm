/**
 * Copies the file-type icons out of the Vir Icons VS Code extension and writes the lookup map the
 * Diff pane's sidebar uses, so the pane's icons match the editor's without the app depending on VS
 * Code being installed. Run by hand after changing the icon theme, then `npm run format` — the
 * emitted map is not prettier-clean on its own. Both outputs are committed.
 *
 * Only file icons are taken. The folder icons in the extension have no consumer — the sidebar is a
 * flat list of changed files.
 */
import {
    fileIconMapPath,
    fileIconsDir,
    virIconsExtensionDir,
    vsCodeBundledExtensionsDir,
} from '@agent-storm/server/src/file-paths.js';
import {
    getObjectTypedEntries,
    log,
    removeDuplicates,
    typedObjectFromEntries,
} from '@augment-vir/common';
import {copyFile, mkdir, readdir, readFile, rm, writeFile} from 'node:fs/promises';
import {basename, resolve} from 'node:path';

/**
 * The subset of a VS Code icon theme this script reads. `iconDefinitions` maps a definition name to
 * the svg that draws it; the other two map what a file looks like to one of those names.
 */
type IconTheme = {
    iconDefinitions: Record<string, {iconPath?: string | undefined}>;
    fileExtensions?: Record<string, string> | undefined;
    fileNames?: Record<string, string> | undefined;
    languageIds?: Record<string, string> | undefined;
    file?: string | undefined;
};

/** The one part of a VS Code extension manifest this script reads. */
type LanguageContributingManifest = {
    contributes?:
        | {
              languages?:
                  | ReadonlyArray<{
                        id?: string | undefined;
                        extensions?: ReadonlyArray<string> | undefined;
                        filenames?: ReadonlyArray<string> | undefined;
                    }>
                  | undefined;
          }
        | undefined;
};

/**
 * What file extensions and bare file names each language id claims, read from VS Code's bundled
 * language extensions. Without this the theme's `languageIds` entries are unreachable — which is
 * most of the common ones, since a theme keys TypeScript under `typescript` and not under `ts`.
 */
async function readLanguageClaims(): Promise<
    Record<string, {extensions: string[]; fileNames: string[]}>
> {
    const manifestDirs = await readdir(vsCodeBundledExtensionsDir);
    const manifests = await Promise.all(
        manifestDirs.map(async (dir) => {
            const contents = await readFile(
                resolve(vsCodeBundledExtensionsDir, dir, 'package.json'),
                'utf8',
            ).catch(() => undefined);
            return contents
                ? (JSON.parse(contents) as LanguageContributingManifest)
                : /** Not every entry is an extension directory with a manifest. */
                  undefined;
        }),
    );

    return manifests
        .flatMap((manifest) => manifest?.contributes?.languages || [])
        .reduce(
            (accum, language) => {
                if (!language.id) {
                    return accum;
                }
                const existing = accum[language.id];
                return {
                    ...accum,
                    [language.id]: {
                        extensions: [
                            ...(existing?.extensions || []),
                            ...(language.extensions || []),
                        ],
                        fileNames: [
                            ...(existing?.fileNames || []),
                            ...(language.filenames || []),
                        ],
                    },
                };
            },
            {} as Record<string, {extensions: string[]; fileNames: string[]}>,
        );
}

/** Resolve a definition name to the svg's file name, dropping any that has no drawable path. */
function toIconFileName(theme: Readonly<IconTheme>, definitionName: string): string | undefined {
    const iconPath = theme.iconDefinitions[definitionName]?.iconPath;
    return iconPath ? basename(iconPath) : undefined;
}

function toIconEntries(
    theme: Readonly<IconTheme>,
    lookup: Readonly<Record<string, string>> | undefined,
): [
    string,
    string,
][] {
    return getObjectTypedEntries(lookup || {}).flatMap(
        ([
            key,
            definitionName,
        ]) => {
            const iconFileName = toIconFileName(theme, definitionName);
            return iconFileName
                ? [
                      [
                          key.toLowerCase(),
                          iconFileName,
                      ] satisfies [
                          string,
                          string,
                      ],
                  ]
                : [];
        },
    );
}

/**
 * Flatten the theme's language-keyed icons onto the extensions and file names each language claims.
 * Returned separately from the theme's own maps because these lose to them: VS Code checks
 * `fileNames`, then `fileExtensions`, and only falls back to the file's language.
 */
function toLanguageIconEntries(
    theme: Readonly<IconTheme>,
    claims: Readonly<Record<string, {extensions: string[]; fileNames: string[]}>>,
    key: 'extensions' | 'fileNames',
): [
    string,
    string,
][] {
    return getObjectTypedEntries(theme.languageIds || {}).flatMap(
        ([
            languageId,
            definitionName,
        ]) => {
            const iconFileName = toIconFileName(theme, definitionName);
            const claimed = claims[languageId]?.[key];
            if (!iconFileName || !claimed) {
                return [];
            }
            return claimed.map((claim) => {
                /** Language extensions carry a leading dot; the theme's own keys do not. */
                return [
                    claim.toLowerCase().replace(/^\./, ''),
                    iconFileName,
                ] satisfies [
                    string,
                    string,
                ];
            });
        },
    );
}

/** Source the map's keys sort so the generated file's diff stays readable across regenerations. */
function sortEntries(
    entries: ReadonlyArray<
        [
            string,
            string,
        ]
    >,
): [
    string,
    string,
][] {
    return entries.toSorted(([a], [b]) => a.localeCompare(b));
}

function toMapSource(record: Readonly<Record<string, string>>): string {
    return getObjectTypedEntries(record)
        .map(
            ([
                key,
                value,
            ]) => `    ${JSON.stringify(key)}: ${JSON.stringify(value)},`,
        )
        .join('\n');
}

async function main(): Promise<void> {
    const theme = JSON.parse(
        await readFile(resolve(virIconsExtensionDir, 'icons.json'), 'utf8'),
    ) as IconTheme;

    const claims = await readLanguageClaims();

    /**
     * Language-derived entries go first in each list so the theme's explicit ones overwrite them,
     * matching the precedence VS Code applies.
     */
    const byFileName = typedObjectFromEntries(
        sortEntries([
            ...toLanguageIconEntries(theme, claims, 'fileNames'),
            ...toIconEntries(theme, theme.fileNames),
        ]),
    );
    const byExtension = typedObjectFromEntries(
        sortEntries([
            ...toLanguageIconEntries(theme, claims, 'extensions'),
            ...toIconEntries(theme, theme.fileExtensions),
        ]),
    );
    const defaultIcon = theme.file ? toIconFileName(theme, theme.file) : undefined;

    const iconFileNames = removeDuplicates([
        ...Object.values(byFileName),
        ...Object.values(byExtension),
        ...(defaultIcon ? [defaultIcon] : []),
    ]);

    await rm(fileIconsDir, {
        force: true,
        recursive: true,
    });
    await mkdir(fileIconsDir, {
        recursive: true,
    });
    await Promise.all(
        iconFileNames.map(async (iconFileName) => {
            await copyFile(
                resolve(virIconsExtensionDir, 'file-icons', 'icons', iconFileName),
                resolve(fileIconsDir, iconFileName),
            );
        }),
    );

    await writeFile(
        fileIconMapPath,
        [
            '/* eslint-disable */',
            '',
            '/**',
            ' * Generated by packages/scripts/src/generate-file-icons.script.ts from the Vir Icons VS Code',
            ' * extension. Do not edit by hand.',
            ' */',
            '',
            `export const defaultFileIcon = ${JSON.stringify(defaultIcon || '')};`,
            '',
            '/** Whole lowercased file name to icon, checked before {@link fileIconsByExtension}. */',
            'export const fileIconsByName: Readonly<Record<string, string>> = {',
            toMapSource(byFileName),
            '};',
            '',
            '/** Lowercased extension, without its leading dot, to icon. */',
            'export const fileIconsByExtension: Readonly<Record<string, string>> = {',
            toMapSource(byExtension),
            '};',
            '',
        ].join('\n'),
    );

    log.success(
        [
            `Copied ${iconFileNames.length} icons to ${fileIconsDir}`,
            `Wrote ${Object.keys(byFileName).length} name and ${Object.keys(byExtension).length} extension mappings to ${fileIconMapPath}`,
        ].join('\n'),
    );
}

await main();
