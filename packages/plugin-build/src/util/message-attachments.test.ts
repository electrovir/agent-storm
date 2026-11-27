import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {splitMessageAttachments} from './message-attachments.js';

const uploadsDir = '/var/folders/xy/T/agent-storm-plugins/build';

describe(splitMessageAttachments.name, () => {
    it('splits trailing upload paths off the text', () => {
        assert.deepEquals(
            splitMessageAttachments(
                [
                    'look at these',
                    `${uploadsDir}/1763500000000-a12345678901234567890123-screen_shot.PNG`,
                    `${uploadsDir}/1763500000001-b12345678901234567890123-pasted-text.txt`,
                ].join('\n'),
            ),
            {
                text: 'look at these',
                attachments: [
                    {
                        path: `${uploadsDir}/1763500000000-a12345678901234567890123-screen_shot.PNG`,
                        name: 'screen_shot.PNG',
                        tag: 'PNG',
                        isImage: true,
                        isPastedText: false,
                    },
                    {
                        path: `${uploadsDir}/1763500000001-b12345678901234567890123-pasted-text.txt`,
                        name: 'pasted-text.txt',
                        tag: 'Pasted',
                        isImage: false,
                        isPastedText: true,
                    },
                ],
            },
        );
    });
    it('leaves paths that are not uploads or not at the end in the text', () => {
        const text = [
            `${uploadsDir}/1763500000000-a12345678901234567890123-a.png`,
            'then',
            '/repos/app/src/index.ts',
        ].join('\n');

        assert.deepEquals(splitMessageAttachments(text), {
            text,
            attachments: [],
        });
    });
});
