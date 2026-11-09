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
});
