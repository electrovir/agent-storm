import {ptyService} from '@agent-storm/common';
import {log} from '@augment-vir/common';
import {implementService} from '@rest-vir/implement-service';
import {startService} from '@rest-vir/run-service';
import {spawn, type IPty} from 'node-pty';

const port = 3000;

const ptyByWebSocket = new WeakMap<object, IPty>();

const ptyImpl = implementService({
    service: ptyService,
})({
    webSockets: {
        '/pty': {
            open({webSocket}) {
                const childPty = spawn(process.env.SHELL || '/bin/zsh', [], {
                    name: 'xterm-256color',
                    cols: 80,
                    rows: 24,
                    cwd: process.env.HOME || process.cwd(),
                });
                childPty.onData((data) => {
                    webSocket.send(data);
                });
                childPty.onExit(async () => {
                    await webSocket.close();
                });
                ptyByWebSocket.set(webSocket, childPty);
            },
            message({webSocket, message}) {
                ptyByWebSocket.get(webSocket)?.write(message);
            },
            close({webSocket}) {
                ptyByWebSocket.get(webSocket)?.kill();
                ptyByWebSocket.delete(webSocket);
            },
        },
    },
});

await startService(ptyImpl, {
    port,
    workerCount: 1,
});

log.success(`PTY server listening on http://localhost:${port}`);
