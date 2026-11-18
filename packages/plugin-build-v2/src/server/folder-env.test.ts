import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {parseFolderEnv} from './folder-env.js';

const marker = '\0agent-storm-folder-env\0';

describe(parseFolderEnv.name, () => {
    it('ignores output before the marker and keeps "=" inside values', () => {
        assert.deepEquals(
            parseFolderEnv(
                [
                    'welcome banner',
                    marker,
                    'A=b=c\0HOME=/home/someone\0',
                ].join(''),
            ),
            {
                A: 'b=c',
                HOME: '/home/someone',
            },
        );
    });

    it('throws when the marker is missing', () => {
        assert.throws(() => parseFolderEnv('A=b\0'), {
            matchMessage: 'no environment',
        });
    });
});
