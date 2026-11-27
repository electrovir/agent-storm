import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {mkdtemp, rm, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AiProvider} from '../build-api.js';
import {createThreadLaunchStore} from './thread-launch-store.js';

describe(createThreadLaunchStore.name, () => {
    it('reads back an owner-only launch and nothing for other threads', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'thread-launch-store-test-'));
        try {
            const store = createThreadLaunchStore(dir);
            await store.write({
                threadId: 'thread-1',
                provider: AiProvider.Codex,
                apiKey: 'fake-key',
                env: {
                    BOT_RUN: '1',
                },
            });
            assert.deepEquals(
                await Promise.all([
                    createThreadLaunchStore(dir).read('thread-1'),
                    createThreadLaunchStore(dir).read('thread-2'),
                ]),
                [
                    {
                        provider: AiProvider.Codex,
                        apiKey: 'fake-key',
                        env: {
                            BOT_RUN: '1',
                        },
                    },
                    undefined,
                ],
            );
            assert.strictEquals(
                (await stat(join(dir, 'thread-launches', 'thread-1.json'))).mode & 0o777,
                0o600,
            );
        } finally {
            await rm(dir, {
                recursive: true,
                force: true,
            });
        }
    });
});
