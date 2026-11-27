import {extractErrorMessage, log} from '@augment-vir/common';
import {hasErrorCode, writeFileAtomically} from 'agent-storm-util';
import {readdir, readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {checkValidShape, defineShape, type Shape} from 'object-shape-tester';
import {botRunShape, botSettingsShape, type BotRun} from '../bots-api.js';

/** How many runs each bot's history keeps. */
const maxStoredRuns = 200;

const storedBotsShape = defineShape({
    /** The config files the user approved, by the hash of the contents they read. */
    approvals: [
        {
            repoPath: '',
            hash: '',
        },
    ],
    bots: [
        {
            botId: '',
            settings: botSettingsShape,
        },
    ],
});

export type StoredBots = typeof storedBotsShape.runtimeType;

/** Kept apart from `bots.json` so only this file needs owner-only permissions. */
const storedApiKeysShape = defineShape({
    keys: [
        {
            botId: '',
            apiKey: '',
        },
    ],
});

export type StoredApiKeys = typeof storedApiKeysShape.runtimeType;

const storedRunsShape = defineShape({
    /** Newest first. */
    runs: [
        botRunShape,
    ],
});

/** The Bots plugin's files in its data folder. */
export function createBotsStorage(dataDir: string) {
    const paths = {
        bots: join(dataDir, 'bots.json'),
        apiKeys: join(dataDir, 'api-keys.json'),
        runs: join(dataDir, 'runs'),
    };
    /** Each file's latest write, so writes to one file land in the order they were made. */
    const writes = new Map<string, Promise<void>>();

    async function readStored<const SpecificShape extends Shape>({
        path,
        shape,
    }: Readonly<{
        path: string;
        shape: SpecificShape;
    }>) {
        try {
            const contents: unknown = JSON.parse(await readFile(path, 'utf8'));
            if (checkValidShape(contents, shape)) {
                return contents;
            }
            log.warning(`Ignoring invalid bots file '${path}'.`);
        } catch (error) {
            if (!hasErrorCode(error, 'ENOENT')) {
                log.warning(
                    `Ignoring unreadable bots file '${path}': ${extractErrorMessage(error)}`,
                );
            }
        }
        return undefined;
    }

    async function writeStored({
        path,
        value,
        mode,
    }: Readonly<{
        path: string;
        value: unknown;
        mode?: number | undefined;
    }>) {
        const write = (writes.get(path) || Promise.resolve())
            .catch(() => undefined)
            .then(async () => {
                await writeFileAtomically({
                    path,
                    contents: JSON.stringify(value, undefined, 4),
                    mode,
                });
            });
        writes.set(path, write);
        await write;
    }

    function toRunsPath(botId: string) {
        return join(paths.runs, `${botId}.json`);
    }

    return {
        async readBots() {
            return (
                (await readStored({
                    path: paths.bots,
                    shape: storedBotsShape,
                })) || {
                    approvals: [],
                    bots: [],
                }
            );
        },
        async writeBots(value: Readonly<StoredBots>) {
            await writeStored({
                path: paths.bots,
                value,
            });
        },
        async readApiKeys() {
            return (
                (await readStored({
                    path: paths.apiKeys,
                    shape: storedApiKeysShape,
                })) || {
                    keys: [],
                }
            );
        },
        async writeApiKeys(value: Readonly<StoredApiKeys>) {
            await writeStored({
                path: paths.apiKeys,
                value,
                mode: 0o600,
            });
        },
        /** Every bot's run history that was ever saved, by bot id. */
        async readAllRuns() {
            const fileNames = await readdir(paths.runs).catch((error: unknown) => {
                if (hasErrorCode(error, 'ENOENT')) {
                    return [];
                }
                throw error;
            });
            const botIds = fileNames
                .filter((fileName) => fileName.endsWith('.json'))
                .map((fileName) => fileName.slice(0, -'.json'.length));
            return new Map(
                await Promise.all(
                    botIds.map(async (botId) => {
                        const stored = await readStored({
                            path: toRunsPath(botId),
                            shape: storedRunsShape,
                        });
                        return [
                            botId,
                            stored?.runs || [],
                        ] as const;
                    }),
                ),
            );
        },
        /** Keeps only the newest runs. */
        async writeRuns({
            botId,
            runs,
        }: Readonly<{
            botId: string;
            runs: ReadonlyArray<Readonly<BotRun>>;
        }>) {
            await writeStored({
                path: toRunsPath(botId),
                value: {
                    runs: runs.slice(0, maxStoredRuns),
                },
            });
        },
    };
}

export type BotsStorage = ReturnType<typeof createBotsStorage>;
