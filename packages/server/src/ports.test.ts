import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {PortEnvVar, readEnvPort} from './ports.js';

describe(readEnvPort.name, () => {
    it('reads a valid port and rejects everything else', () => {
        const original = process.env[PortEnvVar.Frontend];
        try {
            const results = [
                '41999',
                '',
                'abc',
                '0',
                '70000',
                '41.5',
            ].map((value) => {
                process.env[PortEnvVar.Frontend] = value;
                return readEnvPort(PortEnvVar.Frontend);
            });
            assert.deepEquals(results, [
                41_999,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
            ]);
        } finally {
            if (original == undefined) {
                delete process.env[PortEnvVar.Frontend];
            } else {
                process.env[PortEnvVar.Frontend] = original;
            }
        }
    });
});
