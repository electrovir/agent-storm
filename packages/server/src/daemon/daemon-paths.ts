import {tmpdir} from 'node:os';
import {join} from 'node:path';

export const daemonSocketPath = join(tmpdir(), 'agent-storm-pty.sock');
export const daemonLogPath = join(tmpdir(), 'agent-storm-pty-daemon.log');
