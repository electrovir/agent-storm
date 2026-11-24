import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {listUnfinishedSpans} from './debug-log.js';

describe(listUnfinishedSpans.name, () => {
    it('lists only the spans that never ended', () => {
        assert.deepEquals(
            listUnfinishedSpans([
                {
                    event: 'start a',
                },
                {
                    event: 'start b',
                },
                {
                    event: 'end b',
                },
            ]),
            [
                'a',
            ],
        );
    });
    it('ignores an end whose start was trimmed off the trail', () => {
        assert.deepEquals(
            listUnfinishedSpans([
                {
                    event: 'end a',
                },
            ]),
            [],
        );
    });
});
