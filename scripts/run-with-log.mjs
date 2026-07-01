#!/usr/bin/env node
/**
 * Wraps a child command so all of its stdout/stderr is mirrored to .logs/dev.log
 * in addition to the parent terminal. The log file is truncated on each start
 * and ANSI color codes are stripped on the way to the file so the log stays
 * readable for tools that grep it.
 */
import {spawn} from 'node:child_process';
import {mkdirSync, createWriteStream} from 'node:fs';
import {dirname, resolve} from 'node:path';

const args = process.argv.slice(2);
if (args.length === 0) {
    console.error('run-with-log: expected a command to run');
    process.exit(2);
}

const logPath = resolve('.logs/dev.log');
mkdirSync(dirname(logPath), {recursive: true});
const logStream = createWriteStream(logPath, {flags: 'w'});

const startBanner = `=== npm start @ ${new Date().toISOString()} ===\n`;
process.stdout.write(startBanner);
logStream.write(startBanner);

const child = spawn(args[0], args.slice(1), {
    stdio: [
        'inherit',
        'pipe',
        'pipe',
    ],
    env: {
        ...process.env,
        FORCE_COLOR: '1',
    },
});

const ansiRegex = /\x1B\[[0-9;]*[A-Za-z]/g;

function tee(input, terminal) {
    input.on('data', (chunk) => {
        terminal.write(chunk);
        logStream.write(chunk.toString().replace(ansiRegex, ''));
    });
}

tee(child.stdout, process.stdout);
tee(child.stderr, process.stderr);

function forward(signal) {
    process.on(signal, () => {
        if (!child.killed) child.kill(signal);
    });
}
forward('SIGINT');
forward('SIGTERM');
forward('SIGHUP');

child.on('exit', (code, signal) => {
    const trailer = `=== exited (code=${code}, signal=${signal ?? 'none'}) @ ${new Date().toISOString()} ===\n`;
    process.stdout.write(trailer);
    logStream.write(trailer);
    logStream.end(() => {
        if (signal) process.kill(process.pid, signal);
        else process.exit(code ?? 0);
    });
});
