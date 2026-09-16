// cspell:words unparseable, pids

import {assert, assertWrap, waitUntil} from '@augment-vir/assert';
import {wait} from '@augment-vir/common';
import {describe, it} from '@augment-vir/test';
import {spawn} from 'node:child_process';
import {collectDescendantPids, killProcessTree, parseProcessTable} from './kill-process-tree.js';

const sampleTable = [
    '    1     0',
    '  100     1',
    '  200   100',
    '  201   100',
    '  300   200',
    '  400     1',
    'garbage line',
    '',
].join('\n');

describe(parseProcessTable.name, () => {
    it('parses pid/ppid pairs and drops unparseable lines', () => {
        assert.deepEquals(parseProcessTable(sampleTable), [
            {
                pid: 1,
                ppid: 0,
            },
            {
                pid: 100,
                ppid: 1,
            },
            {
                pid: 200,
                ppid: 100,
            },
            {
                pid: 201,
                ppid: 100,
            },
            {
                pid: 300,
                ppid: 200,
            },
            {
                pid: 400,
                ppid: 1,
            },
        ]);
    });
});

describe(collectDescendantPids.name, () => {
    it('collects the full descendant subtree, deepest-first within each branch', () => {
        assert.deepEquals(
            collectDescendantPids(sampleTable, 100),
            [
                200,
                300,
                201,
            ],
        );
    });

    it('returns an empty list for a leaf process', () => {
        assert.deepEquals(collectDescendantPids(sampleTable, 300), []);
    });
});

describe(killProcessTree.name, () => {
    it('kills a process and all of its descendants', async () => {
        /**
         * A parent shell that spawns two long-lived children and then blocks — mirrors the
         * shell→agent process tree a pane creates. The children print their pids so the test can
         * confirm each one is gone.
         */
        const root = spawn(
            '/bin/bash',
            [
                '-c',
                'sleep 120 & firstChild=$!; sleep 120 & secondChild=$!; echo "$firstChild $secondChild"; wait',
            ],
            {
                stdio: [
                    'ignore',
                    'pipe',
                    'ignore',
                ],
            },
        );
        const rootPid = assertWrap.isDefined(root.pid);
        const rootStdout = assertWrap.isDefined(root.stdout);

        const childPids = await new Promise<number[]>((resolve, reject) => {
            rootStdout.on('data', (chunk: Buffer) => {
                resolve(chunk.toString('utf-8').trim().split(/\s+/).map(Number));
            });
            root.on('error', reject);
        });

        killProcessTree(rootPid, {
            expectedParentPid: process.pid,
            immediate: true,
        });

        const allPids = [
            rootPid,
            ...childPids,
        ];
        await waitUntil(
            () => {
                return allPids.every((pid) => {
                    try {
                        process.kill(pid, 0);
                        return false;
                    } catch {
                        return true;
                    }
                });
            },
            {
                interval: {
                    milliseconds: 20,
                },
                timeout: {
                    seconds: 5,
                },
            },
        );
    });

    it('leaves a process alone when it is not a child of the expected parent', async () => {
        const stranger = spawn('/bin/bash', [
            '-c',
            'sleep 120',
        ]);
        const strangerPid = assertWrap.isDefined(stranger.pid);
        try {
            assert.isFalse(
                killProcessTree(strangerPid, {
                    /** Its real parent is this test process, so pid 1 stands in for a stale one. */
                    expectedParentPid: 1,
                    immediate: true,
                }),
            );
            await wait({
                milliseconds: 100,
            });
            process.kill(strangerPid, 0);
        } finally {
            killProcessTree(strangerPid, {
                expectedParentPid: process.pid,
                immediate: true,
            });
        }
    });
});
