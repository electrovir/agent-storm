import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {runCommand} from './run-command.js';

describe(runCommand.name, () => {
    it('passes stdin through to the child', async () => {
        const {stdout} = await runCommand('cat', [], {
            timeout: {
                seconds: 5,
            },
            stdin: 'piped text',
        });
        assert.strictEquals(stdout, 'piped text');
    });

    it('kills a child that outlives its timeout', async () => {
        await assert.throws(
            runCommand(
                'sleep',
                [
                    '5',
                ],
                {
                    timeout: {
                        milliseconds: 100,
                    },
                },
            ),
        );
    });

    it('gives up on a child that does not exit when killed', async () => {
        const startedAt = Date.now();
        await assert.throws(
            runCommand(
                'sh',
                [
                    '-c',
                    'trap "" TERM; sleep 10',
                ],
                {
                    timeout: {
                        milliseconds: 100,
                    },
                },
            ),
        );
        assert.isBelow(Date.now() - startedAt, 5000);
    });
});
