import {assert, waitUntil} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {attachHostedProcess, killHostedProcess, listHostedProcessIds} from './process-pool.js';

function createRecordingClient() {
    const output = {
        text: '',
    };
    return {
        output,
        client: {
            onStdout(data: Buffer) {
                output.text += data.toString('utf-8');
            },
            onExit() {},
            onReplaced() {},
        },
    };
}

function spawnNode(script: string) {
    return {
        command: process.execPath,
        args: [
            '-e',
            script,
        ],
        cwd: process.cwd(),
        env: {
            PATH: process.env.PATH || '',
        },
    };
}

describe(attachHostedProcess.name, () => {
    it('delivers output written while detached to the next attach', async () => {
        const processId = 'test:detached-output';
        const first = createRecordingClient();
        const firstAttach = attachHostedProcess({
            processId,
            spawnOptions: spawnNode(
                "process.stdin.on('data', (data) => process.stdout.write('echo:' + data));",
            ),
            isJsonRpc: false,
            client: first.client,
        });
        assert.isDefined(firstAttach);
        firstAttach.write(Buffer.from('hello'));
        firstAttach.detach();

        const second = createRecordingClient();
        const secondAttach = attachHostedProcess({
            processId,
            spawnOptions: undefined,
            isJsonRpc: false,
            client: second.client,
        });
        try {
            assert.isDefined(secondAttach);
            await waitUntil.isTruthy(() => second.output.text === 'echo:hello');
            assert.deepEquals(
                {
                    isNew: [
                        firstAttach.isNew,
                        secondAttach.isNew,
                    ],
                    firstOutput: first.output.text,
                },
                {
                    isNew: [
                        true,
                        false,
                    ],
                    firstOutput: '',
                },
            );
        } finally {
            killHostedProcess(processId);
        }
    });

    it('sends unanswered JSON-RPC requests again to the next attach', async () => {
        const processId = 'test:open-requests';
        const first = createRecordingClient();
        const firstAttach = attachHostedProcess({
            processId,
            spawnOptions: spawnNode(
                [
                    'process.stdout.write(\'{"id":1,"method":"ask"}\\n{"id":2,"method":"ask"}\\n\');',
                    'process.stdin.resume();',
                ].join(''),
            ),
            isJsonRpc: true,
            client: first.client,
        });
        assert.isDefined(firstAttach);
        await waitUntil.isTruthy(() => first.output.text.split('\n').length === 3);
        firstAttach.write(Buffer.from('{"id":1,"result":{}}\n'));
        firstAttach.detach();

        const second = createRecordingClient();
        try {
            assert.isDefined(
                attachHostedProcess({
                    processId,
                    spawnOptions: undefined,
                    isJsonRpc: true,
                    client: second.client,
                }),
            );
            assert.strictEquals(second.output.text, '{"id":2,"method":"ask"}\n');
        } finally {
            killHostedProcess(processId);
        }
    });

    it('drops a process once it exits', async () => {
        const processId = 'test:exit';
        const exits: Array<number | null> = [];
        attachHostedProcess({
            processId,
            spawnOptions: spawnNode('process.exit(3);'),
            isJsonRpc: false,
            client: {
                onStdout() {},
                onExit({exitCode}) {
                    exits.push(exitCode);
                },
                onReplaced() {},
            },
        });
        await waitUntil.isLengthAtLeast(1, () => exits);
        assert.deepEquals(
            {
                exits,
                isListed: listHostedProcessIds().includes(processId),
            },
            {
                exits: [
                    3,
                ],
                isListed: false,
            },
        );
    });
});

describe('JSON-RPC output', () => {
    it('keeps a character split across two stdout chunks', async () => {
        const processId = 'test:split-character';
        const line = '{"note":"€"}\n';
        const recording = createRecordingClient();
        const attachment = attachHostedProcess({
            processId,
            spawnOptions: spawnNode(
                [
                    `const bytes = Buffer.from(${JSON.stringify(line)});`,
                    'process.stdout.write(bytes.subarray(0, 10));',
                    'setTimeout(() => process.stdout.write(bytes.subarray(10)), 50);',
                ].join('\n'),
            ),
            isJsonRpc: true,
            client: recording.client,
        });
        try {
            assert.isDefined(attachment);
            await waitUntil.isTruthy(() => recording.output.text.endsWith('\n'));
            assert.strictEquals(recording.output.text, line);
        } finally {
            killHostedProcess(processId);
        }
    });
});
