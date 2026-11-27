import {getObjectTypedEntries, typedObjectFromEntries} from '@augment-vir/common';
import {hasErrorCode, writeFileAtomically} from 'agent-storm-util';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {assertWrapValidShape, defineShape, enumShape} from 'object-shape-tester';
import {AiProvider} from '../build-api.js';

const threadLaunchShape = defineShape({
    /** The provider `apiKey` belongs to. */
    provider: enumShape(AiProvider),
    /** Empty to use the user's own login. */
    apiKey: '',
    env: [
        {
            name: '',
            value: '',
        },
    ],
});

/**
 * Saves the API key and variables a plugin started a thread with, so the thread's provider gets
 * them again when it starts after a restart. Each file is owner-only since it may hold an API key.
 */
export function createThreadLaunchStore(dataDir: string) {
    function createPath(threadId: string) {
        return join(dataDir, 'thread-launches', `${threadId}.json`);
    }

    return {
        /** Undefined for a thread started without a key or variables. */
        async read(threadId: string) {
            try {
                const launch = assertWrapValidShape(
                    JSON.parse(await readFile(createPath(threadId), 'utf8')),
                    threadLaunchShape,
                );
                return {
                    ...launch,
                    env: typedObjectFromEntries(
                        launch.env.map(({name, value}) => {
                            return [
                                name,
                                value,
                            ] as const;
                        }),
                    ),
                };
            } catch (error) {
                if (hasErrorCode(error, 'ENOENT')) {
                    return undefined;
                }
                throw error;
            }
        },
        async write({
            threadId,
            provider,
            apiKey,
            env,
        }: Readonly<{
            threadId: string;
            provider: AiProvider;
            apiKey: string;
            env: Readonly<Record<string, string>>;
        }>) {
            await writeFileAtomically({
                path: createPath(threadId),
                contents: JSON.stringify({
                    provider,
                    apiKey,
                    env: getObjectTypedEntries(env).map(
                        ([
                            name,
                            value,
                        ]) => {
                            return {
                                name,
                                value,
                            };
                        },
                    ),
                } satisfies typeof threadLaunchShape.runtimeType),
                mode: 0o600,
            });
        },
    };
}
