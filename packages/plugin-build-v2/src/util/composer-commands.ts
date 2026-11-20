import {escapeStringForRegExp} from '@augment-vir/common';
import {ComposerCommandKind, ComposerCommandSource, type ComposerCommand} from '../build-v2-api.js';

/** The word at the caret, when it asks for the command menu. */
export type ComposerTrigger = Readonly<{
    /** `Command` for a `/` word, which lists commands and skills; `Skill` for a `$` word. */
    kind: ComposerCommandKind;
    /** What follows the `/` or `$`, up to the caret. */
    query: string;
    rangeStart: number;
    /** The caret. */
    rangeEnd: number;
}>;

/**
 * The menu trigger at `cursor` in `text`: a `/` or currency sign starting the word that ends at the
 * caret. A `/` word with another slash in it is a path, and a `$` followed by a number is an
 * amount, so neither opens the menu.
 */
export function detectComposerTrigger({
    text,
    cursor,
}: Readonly<{
    text: string;
    cursor: number;
}>): ComposerTrigger | undefined {
    const word = text.slice(0, cursor).split(/\s/).at(-1) || '';
    const rangeStart = cursor - word.length;
    const wordEnd = cursor + (text.slice(cursor).split(/\s/)[0] || '').length;
    const sign = /^\p{Sc}/u.exec(word)?.[0];
    if (word.startsWith('/')) {
        return /[/\\]/.test(text.slice(rangeStart + 1, wordEnd))
            ? undefined
            : {
                  kind: ComposerCommandKind.Command,
                  query: word.slice(1),
                  rangeStart,
                  rangeEnd: cursor,
              };
    } else if (sign && !/^\.?\d/.test(word.slice(sign.length))) {
        return {
            kind: ComposerCommandKind.Skill,
            query: word.slice(sign.length),
            rangeStart,
            rangeEnd: cursor,
        };
    } else {
        return undefined;
    }
}

function scoreMatch({
    value,
    query,
    tiers,
}: Readonly<{
    value: string;
    query: string;
    /** Lower ranks higher. A match type without a tier doesn't match. */
    tiers: Readonly<{
        exact: number;
        prefix: number;
        boundary?: number | undefined;
        includes: number;
        fuzzy?: number | undefined;
    }>;
}>) {
    if (!value) {
        return undefined;
    }
    const lengthPenalty = Math.min(64, Math.max(0, value.length - query.length));
    if (value === query) {
        return tiers.exact;
    } else if (value.startsWith(query)) {
        return tiers.prefix + lengthPenalty;
    }
    const boundaryIndex =
        tiers.boundary == undefined
            ? -1
            : value.search(new RegExp(`[-_/: ]${escapeStringForRegExp(query)}`));
    if (tiers.boundary != undefined && boundaryIndex !== -1) {
        return tiers.boundary + (boundaryIndex + 1) * 2 + lengthPenalty;
    }
    const includesIndex = value.indexOf(query);
    if (includesIndex !== -1) {
        return tiers.includes + includesIndex * 2 + lengthPenalty;
    } else if (tiers.fuzzy == undefined) {
        return undefined;
    }
    const matchIndexes = value.split('').reduce<number[]>((indexes, character, index) => {
        return indexes.length < query.length && character === query[indexes.length]
            ? [
                  ...indexes,
                  index,
              ]
            : indexes;
    }, []);
    if (matchIndexes.length !== query.length) {
        return undefined;
    }
    const firstMatch = matchIndexes[0] ?? 0;
    /** The characters the fuzzy match skips between its first and last matched character. */
    const skipped = (matchIndexes.at(-1) ?? 0) - firstMatch + 1 - query.length;
    return tiers.fuzzy + firstMatch * 2 + skipped * 4 + lengthPenalty;
}

const composerCommandSourceLabels: Readonly<Record<ComposerCommandSource, string>> = {
    [ComposerCommandSource.BuiltIn]: 'Built-in',
    [ComposerCommandSource.Repo]: 'Repo',
    [ComposerCommandSource.Personal]: 'Personal',
    [ComposerCommandSource.Synced]: 'Synced',
    [ComposerCommandSource.Plugin]: 'Plugin',
    [ComposerCommandSource.Other]: 'Other',
};

const composerCommandKindLabels: Readonly<Record<ComposerCommandKind, string>> = {
    [ComposerCommandKind.Command]: 'command',
    [ComposerCommandKind.Skill]: 'skill',
};

/** Where a command comes from and what it is, such as "Repo skill". */
export function describeComposerCommandOrigin(command: Readonly<ComposerCommand>) {
    return `${composerCommandSourceLabels[command.source]} ${composerCommandKindLabels[command.kind]}`;
}

/** What starts a command's word in a message. */
export const composerCommandSigns: Readonly<Record<ComposerCommandKind, string>> = {
    [ComposerCommandKind.Command]: '/',
    [ComposerCommandKind.Skill]: '$',
};

function scoreCommand(command: Readonly<ComposerCommand>, query: string) {
    const scores = [
        scoreMatch({
            value: command.name.toLowerCase(),
            query,
            tiers: {
                exact: 0,
                prefix: 2,
                boundary: 4,
                includes: 6,
                fuzzy: 100,
            },
        }),
        scoreMatch({
            value: command.description.toLowerCase(),
            query,
            tiers: {
                exact: 20,
                prefix: 22,
                boundary: 24,
                includes: 26,
            },
        }),
        scoreMatch({
            value: describeComposerCommandOrigin(command).toLowerCase(),
            query,
            tiers: {
                exact: 40,
                prefix: 42,
                includes: 44,
            },
        }),
    ].filter((score) => score != undefined);
    return scores.length ? Math.min(...scores) : undefined;
}

/**
 * Built-in commands go last: Claude Code has dozens, and listing them first buries the repo's own
 * skills below the fold of the menu.
 */
const sourceOrder: Readonly<Record<ComposerCommandSource, number>> = {
    [ComposerCommandSource.Repo]: 0,
    [ComposerCommandSource.Personal]: 1,
    [ComposerCommandSource.Plugin]: 2,
    [ComposerCommandSource.Synced]: 3,
    [ComposerCommandSource.Other]: 4,
    [ComposerCommandSource.BuiltIn]: 5,
};

/**
 * The commands `trigger`'s menu lists, best match first. A `$` menu lists only skills. A `/` menu
 * lists skills anywhere but commands only at the start of the message, where Claude Code runs
 * them.
 */
export function listComposerMenuCommands({
    commands,
    trigger,
}: Readonly<{
    commands: ReadonlyArray<Readonly<ComposerCommand>>;
    trigger: ComposerTrigger;
}>) {
    const query = trigger.query.toLowerCase();
    return commands
        .filter((command) => {
            return (
                command.kind === ComposerCommandKind.Skill ||
                (trigger.kind === ComposerCommandKind.Command && !trigger.rangeStart)
            );
        })
        .flatMap((command) => {
            const score = query ? scoreCommand(command, query) : 0;
            return score == undefined
                ? []
                : [
                      {
                          command,
                          score,
                          group: sourceOrder[command.source],
                      },
                  ];
        })
        .sort((left, right) => {
            return (
                left.score - right.score ||
                left.group - right.group ||
                left.command.name.localeCompare(right.command.name)
            );
        })
        .map((entry) => entry.command);
}

/**
 * Splits `text` into whitespace and words, pairing each word that names one of `commands` with it.
 * Matching follows the menu: a skill matches after either sign anywhere, and a command matches only
 * as the message's first word.
 */
export function splitComposerCommandMentions({
    text,
    commands,
}: Readonly<{
    text: string;
    commands: ReadonlyArray<Readonly<ComposerCommand>>;
}>) {
    return text.split(/(\s+)/).map((part, index) => {
        return {
            text: part,
            command: commands.find((command) => {
                return command.kind === ComposerCommandKind.Skill
                    ? Object.values(composerCommandSigns).some((sign) => {
                          return part === `${sign}${command.name}`;
                      })
                    : !index && part === `${composerCommandSigns[command.kind]}${command.name}`;
            }),
        };
    });
}

/**
 * Replaces `trigger`'s word with `command` and a space, reusing a space already after the word.
 * Returns the new text and the caret after the inserted space.
 */
export function insertComposerCommand({
    text,
    trigger,
    command,
}: Readonly<{
    text: string;
    trigger: ComposerTrigger;
    command: Readonly<ComposerCommand>;
}>) {
    const replacement = `${composerCommandSigns[command.kind]}${command.name} `;
    const rangeEnd = text[trigger.rangeEnd] === ' ' ? trigger.rangeEnd + 1 : trigger.rangeEnd;
    return {
        text: [
            text.slice(0, trigger.rangeStart),
            replacement,
            text.slice(rangeEnd),
        ].join(''),
        cursor: trigger.rangeStart + replacement.length,
    };
}
