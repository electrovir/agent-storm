import {extractErrorMessage, log, wrapInTry} from '@augment-vir/common';
import {writeFileAtomically} from 'agent-storm-util';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {defineShape, enumShape, parseJsonWithShape} from 'object-shape-tester';
import {
    AiProvider,
    composerCommandShape,
    providerModelShape,
    type ComposerCommand,
    type ProviderModel,
} from '../build-api.js';

const storedListingsShape = defineShape({
    models: [
        {
            provider: enumShape(AiProvider),
            models: [
                providerModelShape,
            ],
        },
    ],
    commands: [
        {
            key: '',
            commands: [
                composerCommandShape,
            ],
        },
    ],
});

async function readStoredListings(filePath: string) {
    /** A missing or unreadable file means nothing was listed yet. */
    const contents = await readFile(filePath, 'utf8').catch(() => '');
    return (
        wrapInTry(() => parseJsonWithShape(contents, storedListingsShape), {
            fallbackValue: undefined,
        }) || {
            models: [],
            commands: [],
        }
    );
}

/**
 * Each provider's models and each folder's commands as last listed, kept in `dataDir` so the
 * settings and composer show them right after a restart while a fresh listing runs (listing starts
 * a provider CLI, which takes seconds).
 */
export async function openListingCache(dataDir: string) {
    const filePath = join(dataDir, 'listing-cache.json');
    const stored = await readStoredListings(filePath);
    const models = new Map(
        stored.models.map((entry) => {
            return [
                entry.provider,
                entry.models,
            ];
        }),
    );
    const commands = new Map(
        stored.commands.map((entry) => {
            return [
                entry.key,
                entry.commands,
            ];
        }),
    );
    const writes = {
        latest: Promise.resolve(),
    };
    /** Writes are chained so an older write can't land after a newer one. */
    function save() {
        writes.latest = writes.latest
            .then(async () => {
                await writeFileAtomically({
                    path: filePath,
                    contents: JSON.stringify({
                        models: [
                            ...models,
                        ].map(
                            ([
                                provider,
                                providerModels,
                            ]) => {
                                return {
                                    provider,
                                    models: providerModels,
                                };
                            },
                        ),
                        commands: [
                            ...commands,
                        ].map(
                            ([
                                key,
                                keyCommands,
                            ]) => {
                                return {
                                    key,
                                    commands: keyCommands,
                                };
                            },
                        ),
                    } satisfies typeof storedListingsShape.runtimeType),
                });
            })
            .catch((error: unknown) => {
                log.warning(
                    `Saving the model and command lists failed: ${extractErrorMessage(error)}`,
                );
            });
    }
    return {
        readModels(provider: AiProvider) {
            return models.get(provider);
        },
        saveModels(provider: AiProvider, providerModels: ProviderModel[]) {
            models.set(provider, providerModels);
            save();
        },
        /** `key` is `provider:folder`. */
        readCommands(key: string) {
            return commands.get(key);
        },
        saveCommands(key: string, keyCommands: ComposerCommand[]) {
            commands.set(key, keyCommands);
            save();
        },
    };
}
