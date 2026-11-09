import {check} from '@augment-vir/assert';
import {LanguageSupport, StreamLanguage} from '@codemirror/language';

/**
 * Words that open a block, and whose following identifier names the thing being declared.
 * `Unsupported` is not here: it appears in a field's type position, so it is a scalar as far as
 * this tokenizer is concerned.
 */
const blockKeywords: ReadonlyArray<string> = [
    'datasource',
    'enum',
    'generator',
    'model',
    'type',
    'view',
];

const literals: ReadonlyArray<string> = [
    'false',
    'null',
    'true',
];

/**
 * What the next identifier on the current line means. Where a word sits on its line is the whole of
 * Prisma's grammar as far as color goes: the first word names a field or opens a block, the word
 * after it names that field's type, and anything following an attribute is an argument, which VS
 * Code leaves plain.
 */
enum NextIdentifier {
    /** Start of a line: a field name, a block-level setting, or a block keyword. */
    Name = 'name',
    /** Directly after a block keyword, so it names the model, enum, or generator. */
    DeclarationName = 'declaration-name',
    /** Directly after a field name. Scalars and model references land here alike. */
    Type = 'type',
    Plain = 'plain',
}

/**
 * The tag each identifier gets, plus what the identifier after it will be. Keyed by role rather
 * than branched on, so a new role has to answer every case.
 */
const identifierRoles: Record<
    NextIdentifier,
    (text: string) => {
        token: string | undefined;
        next: NextIdentifier;
    }
> = {
    [NextIdentifier.Name](text) {
        return blockKeywords.includes(text)
            ? {
                  token: 'keyword',
                  next: NextIdentifier.DeclarationName,
              }
            : {
                  token: 'propertyName',
                  next: NextIdentifier.Type,
              };
    },
    [NextIdentifier.DeclarationName]() {
        return {
            token: 'className',
            next: NextIdentifier.Plain,
        };
    },
    [NextIdentifier.Type]() {
        return {
            token: 'typeName',
            next: NextIdentifier.Plain,
        };
    },
    [NextIdentifier.Plain]() {
        return {
            token: undefined,
            next: NextIdentifier.Plain,
        };
    },
};

type PrismaState = {
    next: NextIdentifier;
};

/**
 * A Prisma schema tokenizer.
 *
 * Hand-written as a CodeMirror stream parser rather than added as a dependency: there is no
 * official `@codemirror/lang-prisma`, and a schema is small enough to tokenize by hand — line
 * comments, strings, numbers, `@`/`@@` attributes, and identifiers whose meaning comes from where
 * they sit on the line. A real grammar would buy nothing a diff viewer can use.
 *
 * The strings returned are Lezer tag names, so the colors come from the shared highlight style
 * rather than from anything named here.
 */
const prismaLanguage = StreamLanguage.define<PrismaState>({
    name: 'prisma',
    startState() {
        return {
            next: NextIdentifier.Name,
        };
    },
    token(stream, state) {
        if (stream.sol()) {
            state.next = NextIdentifier.Name;
        }
        if (stream.eatSpace()) {
            return null;
        } else if (stream.match('//')) {
            /**
             * `///` is a documentation comment, which Prisma carries into the generated client
             * where a plain `//` is dropped. Both are line comments to a highlighter.
             */
            stream.skipToEnd();
            return 'comment';
        } else if (stream.match(/^"(?:[^"\\]|\\.)*("|$)/)) {
            /** Matching an unterminated string keeps a half-typed line from recoloring the rest. */
            return 'string';
        } else if (stream.match(/^@@?[A-Za-z_][\w.]*/)) {
            /** An attribute's arguments are named parameters, not fields or types. */
            state.next = NextIdentifier.Plain;
            return 'annotation';
        } else if (stream.match(/^\d+(?:\.\d+)?/)) {
            return 'number';
        }

        const word = stream.match(/^[A-Za-z_]\w*/);
        if (!check.isArray(word)) {
            stream.next();
            return null;
        }

        const text = word[0] || '';
        if (literals.includes(text)) {
            return 'bool';
        } else if (stream.peek() === '(') {
            /**
             * A call — `env("DATABASE_URL")`, `cuid(2)`, `now()`. Checked before position, because
             * the first of those sits exactly where a field's type would.
             */
            state.next = NextIdentifier.Plain;
            return 'variableName.function';
        } else {
            const role = identifierRoles[state.next](text);
            state.next = role.next;
            return role.token ?? null;
        }
    },
    languageData: {
        commentTokens: {
            line: '//',
        },
    },
});

export const prismaLanguageSupport = new LanguageSupport(prismaLanguage);
