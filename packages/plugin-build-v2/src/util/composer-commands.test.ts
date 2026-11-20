import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {ComposerCommandKind, ComposerCommandSource} from '../build-v2-api.js';
import {
    detectComposerTrigger,
    insertComposerCommand,
    listComposerMenuCommands,
    splitComposerCommandMentions,
} from './composer-commands.js';

function createCommand(
    name: string,
    kind: ComposerCommandKind,
    source = ComposerCommandSource.Personal,
) {
    return {
        name,
        description: '',
        argumentHint: '',
        kind,
        source,
    };
}

describe(detectComposerTrigger.name, () => {
    it('finds the word at the caret', () => {
        assert.deepEquals(
            [
                detectComposerTrigger({
                    text: 'run /rev now',
                    cursor: 8,
                }),
                detectComposerTrigger({
                    text: 'use $dep',
                    cursor: 8,
                }),
            ],
            [
                {
                    kind: ComposerCommandKind.Command,
                    query: 'rev',
                    rangeStart: 4,
                    rangeEnd: 8,
                },
                {
                    kind: ComposerCommandKind.Skill,
                    query: 'dep',
                    rangeStart: 4,
                    rangeEnd: 8,
                },
            ],
        );
    });

    it('ignores paths and amounts', () => {
        assert.deepEquals(
            [
                detectComposerTrigger({
                    text: '/usr/bin',
                    cursor: 3,
                }),
                detectComposerTrigger({
                    text: 'costs $10k',
                    cursor: 10,
                }),
            ],
            [
                undefined,
                undefined,
            ],
        );
    });
});

describe(listComposerMenuCommands.name, () => {
    const commands = [
        createCommand('compact', ComposerCommandKind.Command, ComposerCommandSource.BuiltIn),
        createCommand('code-review', ComposerCommandKind.Skill),
        createCommand('review', ComposerCommandKind.Skill, ComposerCommandSource.Repo),
    ];

    it('ranks exact and prefix matches first', () => {
        assert.deepEquals(
            listComposerMenuCommands({
                commands,
                trigger: {
                    kind: ComposerCommandKind.Command,
                    query: 'rev',
                    rangeStart: 0,
                    rangeEnd: 4,
                },
            }).map((command) => command.name),
            [
                'review',
                'code-review',
            ],
        );
    });

    it('lists built-in commands after the repo and personal ones', () => {
        assert.deepEquals(
            listComposerMenuCommands({
                commands,
                trigger: {
                    kind: ComposerCommandKind.Command,
                    query: '',
                    rangeStart: 0,
                    rangeEnd: 1,
                },
            }).map((command) => command.name),
            [
                'review',
                'code-review',
                'compact',
            ],
        );
    });

    it('lists commands only at the start of the message', () => {
        assert.deepEquals(
            listComposerMenuCommands({
                commands,
                trigger: {
                    kind: ComposerCommandKind.Command,
                    query: '',
                    rangeStart: 5,
                    rangeEnd: 6,
                },
            }).map((command) => command.name),
            [
                'review',
                'code-review',
            ],
        );
    });
});

describe(splitComposerCommandMentions.name, () => {
    it('pairs known skills anywhere and commands only first', () => {
        const review = createCommand('review', ComposerCommandKind.Skill);
        const clear = createCommand('clear', ComposerCommandKind.Command);
        assert.deepEquals(
            splitComposerCommandMentions({
                text: '/clear then $review /review /clear\n$nope',
                commands: [
                    review,
                    clear,
                ],
            }),
            [
                {
                    text: '/clear',
                    command: clear,
                },
                ...[
                    ' ',
                    'then',
                    ' ',
                ].map((text) => {
                    return {
                        text,
                        command: undefined,
                    };
                }),
                {
                    text: '$review',
                    command: review,
                },
                {
                    text: ' ',
                    command: undefined,
                },
                {
                    text: '/review',
                    command: review,
                },
                ...[
                    ' ',
                    '/clear',
                    '\n',
                    '$nope',
                ].map((text) => {
                    return {
                        text,
                        command: undefined,
                    };
                }),
            ],
        );
    });
});

describe(insertComposerCommand.name, () => {
    it('inserts a skill with its sign and reuses the following space', () => {
        assert.deepEquals(
            insertComposerCommand({
                text: 'use $re now',
                trigger: {
                    kind: ComposerCommandKind.Skill,
                    query: 're',
                    rangeStart: 4,
                    rangeEnd: 7,
                },
                command: createCommand('review', ComposerCommandKind.Skill),
            }),
            {
                text: 'use $review now',
                cursor: 12,
            },
        );
    });
});
