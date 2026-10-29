// cspell:words keymap meslo menlo pilcrow prec unstages unstaging desaturated

import {
    DiffLayout,
    GitDiffSide,
    GitFileChange,
    maxDiffFileLines,
    type GitDiffFile,
    type GitDiffFileContents,
    type GitDiffStatus,
} from '@agent-storm/common';
import {check} from '@augment-vir/assert';
import {awaitedForEach, createArray, extractExtension, omitObjectKeys} from '@augment-vir/common';
import {defaultKeymap, history, historyKeymap} from '@codemirror/commands';
import {bracketMatching, foldGutter} from '@codemirror/language';
import {Chunk, MergeView, unifiedMergeView} from '@codemirror/merge';
import {EditorState, Prec, RangeSet, Text, type Extension, type Line} from '@codemirror/state';
import {
    Decoration,
    EditorView,
    GutterMarker,
    ViewPlugin,
    gutter,
    highlightActiveLineGutter,
    keymap,
    lineNumbers,
    type ViewUpdate,
} from '@codemirror/view';
import {colorCss} from '@electrovir/color';
import {
    css,
    defineElement,
    html,
    listen,
    onDomCreated,
    unsafeCSS,
    type CSSResult,
    type HtmlInterpolation,
} from 'element-vir';
import {
    LucideChevronDownIcon,
    LucideChevronLeftIcon,
    LucideChevronRightIcon,
    LucideChevronUpIcon,
    LucideColumns2Icon,
    LucideFileStackIcon,
    LucideLoaderIcon,
    LucideMinusIcon,
    LucidePilcrowIcon,
    LucidePlusIcon,
    LucideRows2Icon,
    LucideUndo2Icon,
    ViraButton,
    ViraCollapsibleCard,
    ViraColorVariant,
    ViraEmphasis,
    ViraIcon,
    ViraMenuItem,
    ViraMenuTrigger,
    ViraSize,
    createSizedIcon,
    viraShadows,
    viraThemeByKeys,
    type ViraIconSvg,
} from 'vira';
import {
    discardGitFile,
    discardGitHunk,
    discardUnstagedGitChanges,
    getConfig,
    getGitDiffFile,
    getGitDiffStatus,
    putConfig,
    setGitFileStaged,
    setGitHunkStaged,
    setGitSideStaged,
} from '../../util/api-client.js';
import {reportRenderError} from '../../util/client-error-log.js';
import {colorsFor} from '../../util/diff-colors.js';
import {foldWhitespaceOnlyChanges} from '../../util/diff-hunks.js';
import {loadSyntaxExtensions} from '../../util/diff-syntax.js';
import {toFileIconUrl} from '../../util/file-icon.js';
import {diffSidebarWidth, localStorageClient} from '../../util/local-storage-client.js';
import {ScreenSize} from '../../util/screen-size.js';
import {isDarkMode, listenToDarkMode} from '../../util/theme-mode.js';
import {diffConfig} from '../../util/vscode-diff.js';
import {imageDiffStyles, renderImageDiff} from './image-diff.js';
import {spinAnimationCss, spinKeyframesCss} from './spin-styles.js';
import {VirDiffReview} from './vir-diff-review.element.js';

/**
 * How often the pane re-reads `git status` and the open file while it's visible. Two seconds is
 * fast enough that an agent's edits show up while you're still looking at the pane, and slow enough
 * that a `git status` per interval is free on a local repo.
 */
const refreshIntervalMs = 2000;

/** Single-letter badge on each file row, matching git's own status letters. */
const changeBadges: Readonly<Record<GitFileChange, string>> = {
    [GitFileChange.Added]: 'A',
    [GitFileChange.Modified]: 'M',
    [GitFileChange.Deleted]: 'D',
    [GitFileChange.Renamed]: 'R',
    [GitFileChange.Untracked]: 'U',
};

/**
 * Badge colors. Deletions read red, additions green, everything else stays neutral so a long file
 * list doesn't turn into a color chart.
 */
const changeBadgeColors: Readonly<Record<GitFileChange, CSSResult>> = {
    [GitFileChange.Added]: viraThemeByKeys.green.foreground.body.foreground.value,
    [GitFileChange.Modified]: viraThemeByKeys.blue.foreground.body.foreground.value,
    [GitFileChange.Deleted]: viraThemeByKeys.red.foreground.body.foreground.value,
    [GitFileChange.Renamed]: viraThemeByKeys.blue.foreground.body.foreground.value,
    [GitFileChange.Untracked]: viraThemeByKeys.grey.foreground['non-body'].foreground.value,
};

const caretIcon = createSizedIcon(LucideChevronDownIcon, 14);

const revertIcon = createSizedIcon(LucideUndo2Icon, 14);

/** Opens the whole side's changes as one scrollable review instead of one file at a time. */
const reviewIcon = createSizedIcon(LucideFileStackIcon, 14);

/** Toolbar toggles read as settings rather than actions, so they sit a size below the nav arrows. */
const splitLayoutIcon = createSizedIcon(LucideColumns2Icon, 12);
const inlineLayoutIcon = createSizedIcon(LucideRows2Icon, 12);
const whitespaceIcon = createSizedIcon(LucidePilcrowIcon, 12);

/** Direction the row's stage button moves the file, matching {@link stageActionLabels}. */
const stageActionIcons: Readonly<Record<GitDiffSide, ViraIconSvg>> = {
    [GitDiffSide.Staged]: createSizedIcon(LucideMinusIcon, 14),
    [GitDiffSide.Unstaged]: createSizedIcon(LucidePlusIcon, 14),
};

/** The same icons a size down, for the buttons stacked in the diff's own gutter. */
const hunkStageIcons: Readonly<Record<GitDiffSide, ViraIconSvg>> = {
    [GitDiffSide.Staged]: createSizedIcon(LucideMinusIcon, 11),
    [GitDiffSide.Unstaged]: createSizedIcon(LucidePlusIcon, 11),
};

/** The gutter pair again at thumb size, for the touch layout's bigger tap targets. */
const mobileHunkStageIcons: Readonly<Record<GitDiffSide, ViraIconSvg>> = {
    [GitDiffSide.Staged]: LucideMinusIcon,
    [GitDiffSide.Unstaged]: LucidePlusIcon,
};

const hunkUndoIcon = createSizedIcon(LucideUndo2Icon, 11);

const loaderIcon = createSizedIcon(LucideLoaderIcon, 24);

/** A path's final segment, which is all the file rows show — the full path is their `title`. */
function basename(path: string): string {
    const parts = extractExtension(path);
    return `${parts.basename}${parts.extension}`;
}

const sideLabels: Readonly<Record<GitDiffSide, string>> = {
    [GitDiffSide.Staged]: 'Staged',
    [GitDiffSide.Unstaged]: 'Changed',
};

/** What clicking the stage button on a file from this side does to it. */
const stageActionLabels: Readonly<Record<GitDiffSide, string>> = {
    [GitDiffSide.Staged]: 'Unstage',
    [GitDiffSide.Unstaged]: 'Stage',
};

/** Same wording, scoped to a single chunk, for the button that floats over each one. */
const stageLabels: Readonly<Record<GitDiffSide, string>> = {
    [GitDiffSide.Staged]: 'Unstage hunk',
    [GitDiffSide.Unstaged]: 'Stage hunk',
};

/**
 * What a menu entry or confirmation will act on, so the scope is visible before the click. Counted
 * in lines rather than hunks when the selection narrowed every chunk it covers, because lines are
 * then what actually moves.
 */
function stageScopeLabel(selections: ReadonlyArray<SelectedChunk>): {
    text: string;
    /** True when the label names a single thing, so a sentence can pick `this` over `these`. */
    isSingular: boolean;
} {
    if (selections.some((selection) => !selection.newLines)) {
        return {
            text: selections.length === 1 ? 'hunk' : `${selections.length} hunks`,
            isSingular: selections.length === 1,
        };
    } else {
        const lineCount = selections.reduce((total, selection) => {
            return (
                total + (selection.newLines ? selection.newLines.to - selection.newLines.from : 0)
            );
        }, 0);
        return {
            text: lineCount === 1 ? 'line' : `${lineCount} lines`,
            isSingular: lineCount === 1,
        };
    }
}

/**
 * Dropdown values have to be plain strings, so a file's identity (which side it's on plus its path)
 * is packed into one. NUL can't occur in either half, which keeps the split unambiguous.
 */
const selectValueSeparator = '\0';

function toSelectValue(side: GitDiffSide, path: string): string {
    return [
        side,
        path,
    ].join(selectValueSeparator);
}

type SelectedFile = {
    side: GitDiffSide;
    file: GitDiffFile;
};

function findSelected(
    status: Readonly<GitDiffStatus> | undefined,
    value: string | undefined,
): SelectedFile | undefined {
    if (!status || !value) {
        return undefined;
    }
    const [
        side,
        path,
    ] = value.split(selectValueSeparator);
    const list = side === GitDiffSide.Staged ? status.staged : status.unstaged;
    const file = list.find((entry) => entry.path === path);
    if (!file || !side) {
        return undefined;
    }
    return {
        side: side === GitDiffSide.Staged ? GitDiffSide.Staged : GitDiffSide.Unstaged,
        file,
    };
}

/** Flat, ordered list of every file across both sides — the order the file-jump buttons walk. */
function allSelectValues(status: Readonly<GitDiffStatus> | undefined): string[] {
    if (!status) {
        return [];
    }
    return [
        ...status.staged.map((file) => toSelectValue(GitDiffSide.Staged, file.path)),
        ...status.unstaged.map((file) => toSelectValue(GitDiffSide.Unstaged, file.path)),
    ];
}

/**
 * Pick the selection to carry into a freshly read status. Exact match wins. Failing that, the same
 * path on the other side does: staging a file removes its unstaged entry and adds a staged one, and
 * the user staged it while reading it, so following it across is what keeps their place. Only a
 * path that is gone from both sides — fully staged and committed, or discarded — falls back to the
 * first file, so the pane never shows a diff for a file that no longer has one.
 */
function reselectValue(
    previousValue: string | undefined,
    values: ReadonlyArray<string>,
): string | undefined {
    if (!previousValue || values.includes(previousValue)) {
        return previousValue || values[0];
    }
    const [
        ,
        previousPath,
    ] = previousValue.split(selectValueSeparator);
    return (
        values.find((value) => value.split(selectValueSeparator)[1] === previousPath) || values[0]
    );
}

/**
 * The file to open after moving `selected` across the index: the neighbor that slides into its
 * place in that side's list, so a run of Stage clicks walks the list rather than following each
 * file over to the other side. Undefined when it was that side's only file, where
 * {@link reselectValue}'s follow-across is all that's left to do.
 */
function nextSideValue(
    status: Readonly<GitDiffStatus> | undefined,
    selected: Readonly<SelectedFile>,
): string | undefined {
    const files = selected.side === GitDiffSide.Staged ? status?.staged : status?.unstaged;
    if (!files) {
        return undefined;
    }
    const index = files.findIndex((file) => file.path === selected.file.path);
    const remaining = files.filter((file) => file.path !== selected.file.path);
    const next = remaining[Math.min(index, remaining.length - 1)];
    return next && toSelectValue(selected.side, next.path);
}

/**
 * The file the folder's pane was last showing, so leaving for another pane or folder and coming
 * back lands on it again. Only a hint: it is fed through {@link reselectValue} against the freshly
 * read status, which drops it for the first file when that path no longer has a diff.
 */
function rememberedFileForFolder(folder: string): string | undefined {
    return localStorageClient.diffFileByFolder.read()[folder];
}

function rememberFileForFolder({
    folder,
    value,
}: Readonly<{
    folder: string;
    value: string | undefined;
}>): void {
    const stored = localStorageClient.diffFileByFolder.read();
    localStorageClient.diffFileByFolder.write(
        value
            ? {
                  ...stored,
                  [folder]: value,
              }
            : omitObjectKeys(stored, [folder]),
    );
}

/** One section of the file menu. Empty sides are dropped before rendering. */
type FileMenuGroup = {
    side: GitDiffSide;
    files: ReadonlyArray<GitDiffFile>;
};

function toMenuGroups(status: Readonly<GitDiffStatus> | undefined): FileMenuGroup[] {
    if (!status) {
        return [];
    }
    return [
        {
            side: GitDiffSide.Staged,
            files: status.staged,
        },
        {
            side: GitDiffSide.Unstaged,
            files: status.unstaged,
        },
    ].filter((group) => group.files.length);
}

/**
 * One file's row contents, shared by the desktop sidebar and the mobile dropdown. The badge comes
 * last so it sits at the row's right edge, just inside the hover-revealed row actions. The full
 * path is still reachable: it's the row's `title`.
 */
function fileRowContents(file: Readonly<GitDiffFile>) {
    return html`
        <img class="file-icon" src=${toFileIconUrl(file.path)} alt="" />
        <span class="file-basename" ?data-deleted=${file.change === GitFileChange.Deleted}>
            ${basename(file.path)}
        </span>
        <span
            class="badge"
            style=${css`
                color: ${changeBadgeColors[file.change]};
            `}
        >
            ${changeBadges[file.change]}
        </span>
    `;
}

/**
 * Columns a wrapped row hangs by, so a continuation reads as part of the line above it rather than
 * as a new statement at column zero.
 */
const hangingIndentColumns = 4;

/**
 * Shared read-only editor extensions. Deliberately minimal: the point of replacing the embedded VS
 * Code is that a phone shouldn't pay for an IDE to read a diff.
 */
function baseExtensions({
    isDark,
    isMobile,
}: Readonly<{isDark: boolean; isMobile: boolean}>): ReadonlyArray<Extension> {
    return [
        lineNumbers(),
        highlightActiveLineGutter(),
        foldGutter(),
        bracketMatching(),
        history(),
        keymap.of([
            ...defaultKeymap,
            ...historyKeymap,
        ]),
        /*
         * Touch reads code by scrolling the pane sideways instead of wrapping it: a wrapped diff on
         * a narrow screen turns every long line into a paragraph, and the change that matters is
         * usually at the end of it.
         */
        ...(isMobile ? [] : [EditorView.lineWrapping]),
        EditorState.readOnly.of(true),
        /*
         * The `dark` flag is what switches CodeMirror's own base theme — gutter background, active
         * line, fold markers — between its light and dark rules. It keys off a class the editor
         * only gets when a registered theme declares itself dark, so without this the gutters stay
         * the light theme's near-white no matter what the rest of the app is doing.
         */
        EditorView.theme(
            {
                /* Font and colors are the user's VS Code editor settings + Vir Colors theme. */
                '&': {
                    height: '100%',
                    fontSize: '10px',
                    backgroundColor: editorSurfaceColors(isDark).background,
                    color: editorSurfaceColors(isDark).foreground,
                },
                '.cm-scroller': {
                    fontFamily: 'Menlo, monospace',
                },
                /*
                 * VS Code draws line numbers straight onto the editor background with no divider,
                 * where CodeMirror's light base theme gives the gutter its own grey fill and a
                 * border.
                 */
                '.cm-gutters': {
                    backgroundColor: editorSurfaceColors(isDark).background,
                    color: editorSurfaceColors(isDark).lineNumber,
                    border: 'none',
                },
                /*
                 * The chunk's own 6px of left padding is dropped because a normal line's text
                 * starts flush against the content edge, and 6px is enough to read as a stray extra
                 * indent level.
                 */
                '.cm-deletedChunk': {
                    paddingLeft: '0',
                },
                /* A hanging indent is only visible on a line that wraps, which touch lines don't. */
                ...(isMobile
                    ? {}
                    : {
                          /*
                           * The hanging indent is one flat amount for every line, applied in CSS.
                           * Matching each line's own indent instead would take a per-line
                           * decoration, and a decoration that changes how a line wraps changes its
                           * height — which is the number the side-by-side layout aligns its two
                           * editors on. When those heights were per line, the aligner drifted and
                           * the new side rendered no text at all.
                           */
                          '.cm-line': {
                              paddingLeft: `${hangingIndentColumns}ch`,
                              textIndent: `-${hangingIndentColumns}ch`,
                          },
                          /*
                           * A removed line in the inline layout is not a `.cm-line` — it is a div
                           * inside the deleted-chunk widget — so it needs the same indent stated
                           * again.
                           */
                          '.cm-deletedChunk > .cm-deletedLine': {
                              paddingLeft: `${hangingIndentColumns}ch`,
                              textIndent: `-${hangingIndentColumns}ch`,
                          },
                      }),
            },
            {
                dark: isDark,
            },
        ),
    ];
}

/**
 * The editor's own surface, unchanged code included. Light comes from the Vir Colors VS Code theme
 * (`editor.background`, `editor.foreground`) plus VS Code's built-in light default for line
 * numbers, which that theme leaves unset. Dark defers to the app around it, since a `transparent`
 * background and an inherited foreground track whatever the surrounding theme is doing.
 */
const editorColors: Readonly<
    Record<
        'light' | 'dark',
        Readonly<{
            background: string;
            foreground: string;
            lineNumber: string;
        }>
    >
> = {
    light: {
        background: '#fafafa',
        foreground: '#383a42',
        lineNumber: '#237893',
    },
    dark: {
        background: 'transparent',
        foreground: 'inherit',
        lineNumber: '#858585',
    },
};

function editorSurfaceColors(isDark: boolean) {
    return isDark ? editorColors.dark : editorColors.light;
}

/**
 * Marks a line whose word-level highlight already covers everything on it. There the darker shade
 * says nothing the pale line tint doesn't, and a whole row of it reads as a second, louder
 * highlight, so the theme rules below flatten those lines back to the line tint alone.
 */
const wholeLineChangedClass = 'agent-storm-whole-line-changed';

/**
 * Whether every word on `line` sits inside `ranges`. Leading and trailing whitespace is ignored:
 * the word highlight usually starts after shared indentation, and a tint over blank columns is not
 * what makes a row look doubly highlighted.
 */
function isLineFullyChanged({
    line,
    ranges,
}: Readonly<{
    line: Readonly<Line>;
    ranges: ReadonlyArray<Readonly<{from: number; to: number}>>;
}>): boolean {
    const leading = line.text.length - line.text.trimStart().length;
    const trailing = line.text.trimEnd().length;
    /** A blank line carries no words to highlight, so there is nothing to flatten. */
    if (trailing <= leading) {
        return false;
    }
    /** Chunk changes come sorted and disjoint, so full coverage means chaining across with no gap. */
    return (
        ranges.reduce(
            (covered, range) => (range.from <= covered && range.to > covered ? range.to : covered),
            line.from + leading,
        ) >=
        line.from + trailing
    );
}

/** Start offsets of the chunk's fully-changed lines, on whichever side this editor shows. */
function wholeLineChangedStarts({
    chunk,
    text,
    isOldSide,
}: Readonly<{chunk: Readonly<Chunk>; text: Text; isOldSide: boolean}>): number[] {
    const base = isOldSide ? chunk.fromA : chunk.fromB;
    const end = isOldSide ? chunk.toA : chunk.toB;
    /** The chunk covers no lines on this side: a pure insertion has nothing in A, and vice versa. */
    if (base >= end) {
        return [];
    }
    const ranges = chunk.changes.map((change) => {
        return {
            from: base + (isOldSide ? change.fromA : change.fromB),
            to: base + (isOldSide ? change.toA : change.toB),
        };
    });
    /** `toA`/`toB` land one past the last line's break, which already belongs to the next line. */
    const firstLineNumber = text.lineAt(Math.min(base, text.length)).number;
    const lastLineNumber = text.lineAt(Math.min(Math.max(base, end - 1), text.length)).number;
    return createArray(lastLineNumber - firstLineNumber + 1, (index) => {
        return text.line(firstLineNumber + index);
    })
        .filter((line) => {
            return isLineFullyChanged({
                line,
                ranges,
            });
        })
        .map((line) => line.from);
}

/**
 * Read off the chunks rather than off the rendered spans, which is the only version of this that
 * holds: CodeMirror rebuilds a line's DOM whenever the highlighter catches up or the viewport
 * moves, and a class poked onto the element from outside the decoration system goes with it.
 */
function wholeLineChangedExtension({
    chunks,
    text,
    isOldSide,
}: Readonly<{
    chunks: ReadonlyArray<Chunk>;
    text: Text;
    isOldSide: boolean;
}>): Extension {
    const lineDecoration = Decoration.line({
        class: wholeLineChangedClass,
    });
    return EditorView.decorations.of(
        Decoration.set(
            chunks
                .flatMap((chunk) => {
                    return wholeLineChangedStarts({
                        chunk,
                        text,
                        isOldSide,
                    });
                })
                .map((from) => lineDecoration.range(from)),
            true,
        ),
    );
}

/**
 * The same flattening for the inline layout's removed lines, which no decoration can reach: they
 * live inside a widget CodeMirror builds itself. Reading the DOM is sound here in a way it is not
 * for real lines — a deletion widget's element is built once per chunk and cached, so no redraw
 * drops the class.
 */
function deletedLineFlattenExtension(): Extension {
    return ViewPlugin.fromClass(
        class {
            constructor(view: EditorView) {
                this.markLines(view);
            }

            public update(update: ViewUpdate) {
                if (update.docChanged || update.viewportChanged || update.geometryChanged) {
                    this.markLines(update.view);
                }
            }

            protected markLines(view: EditorView) {
                view.requestMeasure({
                    read() {
                        return Array.from(
                            view.contentDOM.querySelectorAll('.cm-deletedChunk > .cm-deletedLine'),
                        ).map((line) => {
                            const withoutDeletedText = line.cloneNode(true) as Element;
                            withoutDeletedText
                                .querySelectorAll('.cm-deletedText')
                                .forEach((element) => {
                                    element.remove();
                                });
                            return {
                                line,
                                isWhole:
                                    line.querySelector('.cm-deletedText') != undefined &&
                                    !withoutDeletedText.textContent.trim(),
                            };
                        });
                    },
                    write(lines) {
                        lines.forEach(({line, isWhole}) => {
                            line.classList.toggle(wholeLineChangedClass, isWhole);
                        });
                    },
                });
            }
        },
    );
}

/**
 * Every within-line rule below has to name its editor's `cm-merge-a` / `cm-merge-b` class and use
 * the `background` shorthand. `@codemirror/merge`'s base theme styles `.cm-changedText` through
 * `&light.cm-merge-a .cm-changedText` with a `background:` gradient — three classes and a
 * shorthand, so a two-class `backgroundColor` here loses the cascade and gets reset to transparent
 * by the shorthand.
 */
function deletionColorTheme(isDark: boolean): Extension {
    return EditorView.theme({
        '&.cm-merge-a .cm-changedLine': {
            background: colorsFor(isDark).removedLine,
        },
        '&.cm-merge-a .cm-changedText': {
            background: colorsFor(isDark).removedText,
        },
        [`&.cm-merge-a .cm-changedLine.${wholeLineChangedClass} .cm-changedText`]: {
            background: colorsFor(isDark).removedLine,
        },
    });
}

function insertionColorTheme(isDark: boolean): Extension {
    return EditorView.theme({
        '&.cm-merge-b .cm-changedLine': {
            background: colorsFor(isDark).addedLine,
        },
        '&.cm-merge-b .cm-changedText': {
            background: colorsFor(isDark).addedText,
        },
        [`&.cm-merge-b .cm-changedLine.${wholeLineChangedClass} .cm-changedText`]: {
            background: colorsFor(isDark).addedLine,
        },
    });
}

/** The unified view stacks both sides in one `cm-merge-b` editor, so it needs both color families. */
function unifiedColorTheme(isDark: boolean): Extension {
    return EditorView.theme({
        '& .cm-deletedChunk': {
            background: colorsFor(isDark).removedChunk,
        },
        '& .cm-deletedChunk .cm-deletedLine': {
            background: colorsFor(isDark).removedLine,
        },
        '& .cm-deletedChunk .cm-deletedText, &.cm-merge-b .cm-deletedText': {
            background: colorsFor(isDark).removedText,
        },
        '&.cm-merge-b .cm-insertedLine, &.cm-merge-b .cm-changedLine': {
            background: colorsFor(isDark).addedLine,
        },
        /**
         * A chunk small enough for CodeMirror to show old and new text on one line, rather than as
         * separate deleted and inserted lines. It is a new line carrying its old text inline, so it
         * takes the added tint and the removed words show through in red.
         */
        '&.cm-merge-b .cm-inlineChangedLine': {
            background: colorsFor(isDark).addedLine,
        },
        '&.cm-merge-b .cm-changedText': {
            background: colorsFor(isDark).addedText,
        },
        [`& .cm-deletedChunk .cm-deletedLine.${wholeLineChangedClass} .cm-deletedText`]: {
            background: colorsFor(isDark).removedLine,
        },
        [`&.cm-merge-b .cm-changedLine.${wholeLineChangedClass} .cm-changedText`]: {
            background: colorsFor(isDark).addedLine,
        },
    });
}

const undoHunkLabel = 'Undo hunk';

/** Icon-only, so each button states its action through its `title` instead. */
function buildHunkButton({
    label,
    icon,
    onClick,
}: Readonly<{label: string; icon: ViraIconSvg; onClick: () => void}>): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.title = label;
    button.setAttribute('aria-label', label);
    const iconElement = new ViraIcon();
    iconElement.assignInputs({
        icon,
    });
    button.append(iconElement);
    button.addEventListener('click', (event) => {
        event.preventDefault();
        onClick();
    });
    return button;
}

/**
 * The buttons in the left gutter beside a chunk's first line: move that chunk across the index, and
 * — only for a chunk that isn't staged yet — throw it away. A staged chunk gets no undo button
 * because unstaging it is the reversible way back to the same place, and the destructive one is a
 * click away from there.
 */
class HunkActionMarker extends GutterMarker {
    constructor(
        protected readonly side: GitDiffSide,
        protected readonly isMobile: boolean,
        protected readonly onStage: () => void,
        protected readonly onUndo: (() => void) | undefined,
    ) {
        super();
    }

    public override eq(other: HunkActionMarker): boolean {
        return (
            other.side === this.side &&
            other.isMobile === this.isMobile &&
            (other.onUndo == undefined) === (this.onUndo == undefined)
        );
    }

    public override toDOM(): HTMLElement {
        const wrapper = document.createElement('div');
        wrapper.className = 'agent-storm-hunk-actions';
        const onUndo = this.onUndo;
        wrapper.append(
            /** Stage on top, where it lines up with the chunk's first line. */
            buildHunkButton({
                label: stageLabels[this.side],
                icon: this.isMobile ? mobileHunkStageIcons[this.side] : hunkStageIcons[this.side],
                onClick: this.onStage,
            }),
            ...(onUndo
                ? [
                      buildHunkButton({
                          label: undoHunkLabel,
                          icon: this.isMobile ? LucideUndo2Icon : hunkUndoIcon,
                          onClick: onUndo,
                      }),
                  ]
                : []),
        );
        return wrapper;
    }
}

function hunkButtonExtension({
    chunks,
    newText,
    side,
    isDark,
    isMobile,
    onStageChunk,
    onUndoChunk,
}: Readonly<{
    chunks: ReadonlyArray<Chunk>;
    newText: Text;
    /** Which side the open file is on, which decides what the stage button does and looks like. */
    side: GitDiffSide;
    isDark: boolean;
    /**
     * Sizes the buttons for a thumb and keeps them visible, since touch has no hover to reveal them
     * with.
     */
    isMobile: boolean;
    onStageChunk: (chunk: Readonly<Chunk>) => void;
    /** Undefined for a staged chunk, which shows no undo button. */
    onUndoChunk: ((chunk: Readonly<Chunk>) => void) | undefined;
}>): Extension {
    const markers = RangeSet.of(
        chunks.map((chunk) => {
            /**
             * Anchor at the start of the chunk's first line in the new document. A pure deletion
             * has no lines there, in which case `fromB` is the join point and the buttons land
             * where the removed text would have been.
             */
            const position = newText.lineAt(Math.min(chunk.fromB, newText.length)).from;
            return new HunkActionMarker(
                side,
                isMobile,
                () => onStageChunk(chunk),
                onUndoChunk && (() => onUndoChunk(chunk)),
            ).range(position);
        }),
        true,
    );
    return [
        /**
         * Gutters render in facet order, and the line number gutter registers at default
         * precedence, so raising this one puts it at the far left edge.
         */
        Prec.high(
            gutter({
                class: 'agent-storm-hunk-gutter',
                markers() {
                    return markers;
                },
            }),
        ),
        EditorView.theme({
            /** One button wide, held there so it can't shift as chunks scroll into view. */
            '.agent-storm-hunk-gutter': {
                minWidth: isMobile ? '24px' : '14px',
                padding: '0',
            },
            /**
             * Positioning context for the stack, which is taller than the one line its gutter
             * element occupies. Left in the flow it would push every gutter element below it down
             * and take the line numbers out of step with the code.
             */
            '.agent-storm-hunk-gutter .cm-gutterElement': {
                padding: '0',
                position: 'relative',
            },
            '.agent-storm-hunk-actions': {
                position: 'absolute',
                top: '0',
                right: '0',
                display: 'flex',
                flexDirection: 'column',
                gap: isMobile ? '4px' : '2px',
                alignItems: 'flex-end',
                zIndex: '2',
                ...(isMobile
                    ? {
                          /* Touch has no hover to reveal them with, so they stay out. */
                          opacity: '0.85',
                      }
                    : {
                          /*
                           * Out of sight until the pointer is over the editor, then faint until the pointer is
                           * over the buttons themselves. Hovering a single chunk can't be expressed in CSS —
                           * the lines of a chunk are siblings, not a container — so the trade is that entering
                           * the editor reveals every chunk's buttons at once.
                           */
                          opacity: '0',
                          pointerEvents: 'none',
                          transition: 'opacity 120ms ease',
                      }),
            },
            ...(isMobile
                ? {}
                : {
                      '.cm-scroller:hover .agent-storm-hunk-actions': {
                          opacity: '0.6',
                          pointerEvents: 'auto',
                      },
                      '.agent-storm-hunk-actions:hover, .agent-storm-hunk-actions:focus-within': {
                          opacity: '1',
                      },
                  }),
            '.agent-storm-hunk-actions button': {
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: isMobile ? '22px' : '14px',
                height: isMobile ? '22px' : '14px',
                padding: '0',
                cursor: 'pointer',
                borderRadius: '3px',
                border: isDark
                    ? '1px solid rgba(255, 255, 255, 0.25)'
                    : '1px solid rgba(0, 0, 0, 0.2)',
                background: isDark ? 'rgba(255, 255, 255, 0.14)' : 'rgba(255, 255, 255, 0.85)',
                color: isDark ? '#e6e6e6' : 'inherit',
            },
        }),
    ];
}

type MountedEditor = {
    view: EditorView;
    destroy: () => void;
};

/**
 * Build the diff editor into `parent`. Side-by-side uses a real {@link MergeView}; the inline layout
 * uses {@link unifiedMergeView}, a single editor with the old lines interleaved, because two
 * horizontally-scrolling code columns on a phone are unreadable.
 */
function mountDiffEditor({
    parent,
    root,
    oldContent,
    newContent,
    unified,
    chunks,
    oldText,
    newText,
    side,
    syntaxExtensions,
    isDark,
    isMobile,
    onStageChunk,
    onUndoChunk,
    onGeometryChange,
}: Readonly<{
    parent: HTMLElement;
    /**
     * CodeMirror measures against this root. It must be the shadow root the editor actually lives
     * in, or its cursor and scroll math is computed against the wrong tree.
     */
    root: ShadowRoot;
    oldContent: string;
    newContent: string;
    unified: boolean;
    chunks: ReadonlyArray<Chunk>;
    /** Both sides as {@link Text}, which the caller already built to diff them. */
    oldText: Text;
    newText: Text;
    /** Which side the open file is on, which decides what the hunk buttons do. */
    side: GitDiffSide;
    /** Grammar plus highlight style for this file's type, already resolved by the caller. */
    syntaxExtensions: ReadonlyArray<Extension>;
    /**
     * Theme mode to build the editor for. A change remounts the editor rather than reconfiguring
     * it: the merge view holds two editors plus its own gutter, and the mode changes about as often
     * as the user changes their mind about it.
     */
    isDark: boolean;
    /**
     * Touch layout: bigger hunk buttons, and a horizontally scrolling code pane instead of wrapped
     * lines. Independent of `unified`, which the user can force on either screen size.
     */
    isMobile: boolean;
    onStageChunk: (chunk: Readonly<Chunk>) => void;
    onUndoChunk: ((chunk: Readonly<Chunk>) => void) | undefined;
    /**
     * Fired whenever the new side's layout changes — a resize, a width drag, anything that re-wraps
     * lines. The ruler's marks are pixel positions, so they go stale exactly when this fires.
     */
    onGeometryChange: (view: EditorView) => void;
}>): MountedEditor {
    const hunkButtons = hunkButtonExtension({
        chunks,
        newText,
        side,
        isDark,
        isMobile,
        onStageChunk,
        onUndoChunk,
    });
    const geometryListener = EditorView.updateListener.of((update) => {
        if (update.geometryChanged) {
            onGeometryChange(update.view);
        }
    });

    if (unified) {
        const view = new EditorView({
            parent,
            root,
            doc: newContent,
            extensions: [
                ...baseExtensions({
                    isDark,
                    isMobile,
                }),
                ...syntaxExtensions,
                unifiedColorTheme(isDark),
                wholeLineChangedExtension({
                    chunks,
                    text: newText,
                    isOldSide: false,
                }),
                deletedLineFlattenExtension(),
                hunkButtons,
                geometryListener,
                unifiedMergeView({
                    original: oldContent,
                    /** Read-only pane: there is nothing to revert a chunk into. */
                    mergeControls: false,
                    diffConfig,
                }),
            ],
        });
        return {
            view,
            destroy() {
                return view.destroy();
            },
        };
    }
    const merge = new MergeView({
        parent,
        root,
        a: {
            doc: oldContent,
            extensions: [
                ...baseExtensions({
                    isDark,
                    isMobile,
                }),
                ...syntaxExtensions,
                deletionColorTheme(isDark),
                wholeLineChangedExtension({
                    chunks,
                    text: oldText,
                    isOldSide: true,
                }),
            ],
        },
        b: {
            doc: newContent,
            extensions: [
                ...baseExtensions({
                    isDark,
                    isMobile,
                }),
                ...syntaxExtensions,
                insertionColorTheme(isDark),
                wholeLineChangedExtension({
                    chunks,
                    text: newText,
                    isOldSide: false,
                }),
                hunkButtons,
                geometryListener,
            ],
        },
        gutter: true,
        diffConfig,
    });
    return {
        view: merge.b,
        destroy() {
            return merge.destroy();
        },
    };
}

/**
 * Convert a chunk's character offsets into a 0-based, half-open line range. `to` equals `from` for
 * a chunk that covers no lines on that side (a pure insertion has an empty range in A), and a chunk
 * ending at the last line reports an offset past the end of the document, which is why the upper
 * bound is clamped to the line count rather than looked up.
 */
function toLineRange({text, from, to}: Readonly<{text: Text; from: number; to: number}>): {
    from: number;
    to: number;
} {
    const fromLine = text.lineAt(Math.min(from, text.length)).number - 1;
    if (to <= from) {
        return {
            from: fromLine,
            to: fromLine,
        };
    }
    return {
        from: fromLine,
        to: to > text.length ? text.lines : text.lineAt(to).number - 1,
    };
}

/**
 * The 0-based, half-open line range a character range covers. Unlike a chunk's range a selection
 * can stop anywhere, so the line it ends in counts as covered — except when it stops at that line's
 * very first column, since dragging down to the start of the next line is how a user selects the
 * lines above it.
 */
function selectionLineRange({text, from, to}: Readonly<{text: Text; from: number; to: number}>): {
    from: number;
    to: number;
} {
    const startLine = text.lineAt(Math.min(from, text.length));
    const endLine = text.lineAt(Math.min(to, text.length));
    return {
        from: startLine.number - 1,
        to: to > from && endLine.from === to ? endLine.number - 1 : endLine.number,
    };
}

/**
 * One change to move across the index, and how much of it to move. `newLines` is a 0-based,
 * half-open range of the new document covering fewer lines than the chunk itself; undefined means
 * the whole chunk.
 */
type SelectedChunk = {
    chunk: Chunk;
    newLines:
        | Readonly<{
              from: number;
              to: number;
          }>
        | undefined;
};

/**
 * Everything a range of the new document touches, which is what turns a text selection into
 * something stageable.
 *
 * A selection inside an addition moves only the lines it covers. Anything else moves its whole
 * chunk, because the removed lines that chunk also describes cannot be selected: in the inline
 * layout they are widgets rather than document text, and in the side-by-side one they live in the
 * other editor. Staging a replacement's additions without its removals would leave the index
 * holding both copies of those lines, so the removals come along. VS Code narrows the same cases
 * and no others.
 *
 * A pure deletion covers no new-side text: it is a single point where the removed lines used to be,
 * so it counts as touched when the range reaches that point. Everything else has to genuinely
 * overlap, or a selection ending exactly where the next chunk starts would drag that chunk in too.
 */
function selectedChunksInRange({
    chunks,
    text,
    from,
    to,
}: Readonly<{
    chunks: ReadonlyArray<Chunk>;
    /** The new document, which both the offsets and the narrowed line range are against. */
    text: Text;
    from: number;
    to: number;
}>): SelectedChunk[] {
    const selectedLines = selectionLineRange({
        text,
        from,
        to,
    });
    return chunks
        .filter((chunk) => {
            if (chunk.fromB === chunk.toB) {
                return chunk.fromB >= from && chunk.fromB <= to;
            }
            return from === to
                ? chunk.fromB <= from && from <= chunk.toB
                : chunk.fromB < to && chunk.toB > from;
        })
        .map((chunk) => {
            const chunkLines = toLineRange({
                text,
                from: chunk.fromB,
                to: chunk.toB,
            });
            const narrowed = {
                from: Math.max(chunkLines.from, selectedLines.from),
                to: Math.min(chunkLines.to, selectedLines.to),
            };
            /**
             * An empty range is a right-click with nothing selected, which acts on the chunk under
             * the pointer as a whole — the same thing the hover button does.
             */
            const isNarrowable = from !== to && chunk.fromA === chunk.toA;
            return {
                chunk,
                newLines: isNarrowable && narrowed.to > narrowed.from ? narrowed : undefined,
            };
        });
}

/** One mark on the overview ruler: where a chunk sits in the file and what kind of change it is. */
type RulerMark = {
    topPercent: number;
    heightPercent: number;
    color: CSSResult;
};

/**
 * VS Code's overview ruler colors: `editorGutter.addedBackground` (`#48985D`) and
 * `editorGutter.deletedBackground` (which falls through to `editorError.foreground`, `#E51400`),
 * each at the 0.6 alpha the ruler applies. A replacement is both a removal and an addition, so its
 * mark is split rather than given a third color that has to be learned.
 */
const rulerColors = {
    inserted: unsafeCSS('rgba(72, 152, 93, 0.6)'),
    deleted: unsafeCSS('rgba(229, 20, 0, 0.6)'),
    modified: unsafeCSS('linear-gradient(rgba(229, 20, 0, 0.6) 50%, rgba(72, 152, 93, 0.6) 50%)'),
};

/** Smallest visible ruler mark, so a one-line change in a huge file is still clickable. */
const minRulerMarkPercent = 0.8;

/**
 * Marks are placed by asking the editor where each chunk actually sits, not by dividing line
 * numbers. Wrapped lines and, in the inline layout, the deleted-text widgets mean a line's share of
 * the file is nothing like its share of the scroll height — going by line number puts a mark next
 * to unrelated code.
 */
function toRulerMarks(view: EditorView, chunks: ReadonlyArray<Chunk>): RulerMark[] {
    const totalHeight = Math.max(1, view.contentHeight);
    return chunks.map((chunk) => {
        const start = view.lineBlockAt(Math.min(chunk.fromB, view.state.doc.length));
        const end = view.lineBlockAt(Math.min(chunk.toB, view.state.doc.length));
        return {
            topPercent: (start.top / totalHeight) * 100,
            heightPercent: Math.max(
                minRulerMarkPercent,
                ((end.bottom - start.top) / totalHeight) * 100,
            ),
            color:
                chunk.fromA === chunk.toA
                    ? rulerColors.inserted
                    : chunk.fromB === chunk.toB
                      ? rulerColors.deleted
                      : rulerColors.modified,
        };
    });
}

export const VirDiffPane = defineElement<{
    folder: string;
    /**
     * True when the Diff tab is the visible one. Drives the refresh loop: a hidden pane holds no
     * timer, so background folders cost nothing.
     */
    active: boolean;
    screenSize: ScreenSize;
}>()({
    tagName: 'vir-diff-pane',
    options: {
        errorHandler: reportRenderError,
    },
    state() {
        return {
            status: undefined as GitDiffStatus | undefined,
            statusError: undefined as string | undefined,
            selectedValue: undefined as string | undefined,
            /**
             * Files picked out with cmd/ctrl or shift click, for acting on several at once.
             * Separate from `selectedValue` on purpose: marking files leaves the open diff alone,
             * so the user can keep reading one file while collecting the set to stage.
             *
             * Empty means no multi-selection, and every row button acts on its own row.
             */
            markedValues: [] as ReadonlyArray<string>,
            /** Row a shift click measures its range from: the last row clicked without shift. */
            selectionAnchor: undefined as string | undefined,
            /** Old/new text for the selected file, or undefined while it loads. */
            diffContent: undefined as GitDiffFileContents | undefined,
            /**
             * Selection values whose oversized diff the user asked for anyway. Per file rather than
             * a pane-wide flag, and dropped on folder change, so one deliberate wait doesn't sign
             * the user up for every other huge file in the repo.
             */
            allowLargeValues: [] as ReadonlyArray<string>,
            diffError: undefined as string | undefined,
            editor: undefined as MountedEditor | undefined,
            /**
             * Host element the editor mounts into. Captured via `onDomCreated` because CodeMirror
             * builds its own DOM imperatively and can't be expressed as a lit template.
             */
            editorParent: undefined as HTMLElement | undefined,
            /**
             * Exactly what the mounted editor is showing. The refresh loop re-reads the open file
             * every couple of seconds, and comparing the real content is what keeps an unchanged
             * poll from tearing down the editor and throwing away the user's scroll position.
             */
            rendered: undefined as
                | {
                      value: string;
                      oldContent: string;
                      newContent: string;
                      unified: boolean;
                      isDark: boolean;
                      isMobile: boolean;
                  }
                | undefined,
            /** Mirrors {@link isDarkMode} so the editor can be rebuilt in the other palette. */
            isDark: isDarkMode(),
            stopThemeListener: undefined as (() => void) | undefined,
            chunks: [] as ReadonlyArray<Chunk>,
            rulerMarks: [] as RulerMark[],
            /** Index into `chunks` that the jump buttons move relative to. */
            activeChunkIndex: 0,
            /**
             * Open right-click menu: where the pointer was, in viewport coordinates, and what the
             * selection under it covers. Undefined when no menu is open.
             */
            hunkMenu: undefined as
                | Readonly<{
                      x: number;
                      y: number;
                      selections: ReadonlyArray<SelectedChunk>;
                  }>
                | undefined,
            /**
             * Layout choice from the server config, so it survives a reload and follows the user
             * across browsers. `Auto` (and the moment before the config lands) follows the screen
             * size. The toggle writes the config and updates this in the same step, rather than
             * waiting on a re-read, so the button responds immediately.
             */
            diffLayout: DiffLayout.Auto as DiffLayout,
            /** Companion to `diffLayout`, from the same config read. */
            hideWhitespace: true,
            diffSettingsRequested: false,
            /**
             * Folder the live refresh timer was created for, or undefined when no timer is running.
             * Both the "pane became visible" and "user switched folders" transitions are the same
             * event to this pane — tear the timer down and re-arm it — so one field drives both,
             * and the re-arm is what gives the new interval callback a closure over the current
             * folder.
             */
            armedFolder: undefined as string | undefined,
            refreshTimer: undefined as ReturnType<typeof setInterval> | undefined,
            /**
             * Resolved grammar for `syntaxPath`. The editor waits for this rather than mounting
             * plain and re-mounting when it lands, which would throw away scroll position on every
             * file open.
             */
            syntaxExtensions: [] as ReadonlyArray<Extension>,
            syntaxPath: undefined as string | undefined,
            syntaxLoading: false,
            /** Suppresses overlapping refreshes and disables the stage buttons mid-write. */
            busy: false,
            /**
             * Sidebar sections the user collapsed. Kept here rather than left to each collapsible
             * so the choice survives a section emptying out and coming back.
             */
            collapsedSides: {
                [GitDiffSide.Staged]: false,
                [GitDiffSide.Unstaged]: false,
            } as Readonly<Record<GitDiffSide, boolean>>,
            sidebarWidth: localStorageClient.diffSidebarWidth.read(),
            draggingSidebar: false,
            /**
             * Side whose files are being read as one stacked review, or undefined for the normal
             * one-file diff. The open file is left selected underneath, so leaving the review lands
             * back on it.
             */
            reviewSide: undefined as GitDiffSide | undefined,
        };
    },
    styles: css`
        :host {
            display: flex;
            flex-direction: column;
            width: 100%;
            height: 100%;
            min-height: 0;
            font-family: ui-sans-serif, system-ui, sans-serif;
            font-size: 13px;
        }

        .toolbar {
            display: flex;
            align-items: center;
            gap: 6px;
            flex-grow: 0;
            flex-shrink: 0;
            padding: 6px 8px;
            border-bottom: 1px solid
                ${viraThemeByKeys.grey['behind-bg'].decoration.background.value};
        }

        /*
         * The open file's full path, which nothing else in the pane shows any more — the sidebar
         * rows and the mobile trigger are both down to the base name.
         */
        .selected-path {
            flex-grow: 0;
            flex-shrink: 0;
            padding: 4px 8px;
            overflow: hidden;
            white-space: nowrap;
            text-overflow: ellipsis;
            border-bottom: 1px solid
                ${viraThemeByKeys.grey['behind-bg'].decoration.background.value};
            font-family: 'MesloLGS NF', Menlo, monospace;
            font-size: 11px;
            color: ${viraThemeByKeys.grey.foreground['non-body'].foreground.value};
        }

        /*
         * On mobile the trigger claims the whole first row and the actions wrap below it, so the
         * file name gets full width and the buttons get touch-sized targets.
         */
        .toolbar[data-mobile] {
            flex-wrap: wrap;
            gap: 8px;
        }

        .file-menu {
            flex-grow: 0;
            flex-shrink: 1;
            min-width: 0;
            max-width: 100%;
        }

        /*
         * The 100% basis is only here to force the wrap; the trigger inside still sizes to its own
         * contents, so the picker never stretches across an empty row.
         */
        .toolbar[data-mobile] .file-menu {
            flex-basis: 100%;
        }

        .toolbar-actions {
            display: flex;
            align-items: center;
            gap: 6px;
            flex-grow: 0;
            flex-shrink: 0;
        }

        .toolbar[data-mobile] .toolbar-actions {
            flex-grow: 1;
            justify-content: space-between;
        }

        .toolbar-group {
            display: flex;
            align-items: center;
            gap: 2px;
            flex-grow: 0;
            flex-shrink: 0;
        }

        .file-trigger {
            display: flex;
            align-items: center;
            gap: 8px;
            max-width: 100%;
            box-sizing: border-box;
            appearance: none;
            cursor: pointer;
            font: inherit;
            text-align: left;
            padding: 4px 8px;
            border-radius: 4px;
            border: 1px solid ${viraThemeByKeys.grey['behind-bg'].decoration.background.value};
            ${colorCss(viraThemeByKeys.grey.foreground.body)};
        }

        .toolbar[data-mobile] .file-trigger {
            padding: 8px 10px;
            font-size: 15px;
        }

        .file-trigger:hover:not(:disabled) {
            border-color: ${viraThemeByKeys.blue.foreground.body.foreground.value};
        }

        .file-trigger:disabled {
            cursor: default;
            color: ${viraThemeByKeys.grey.foreground.placeholder.foreground.value};
        }

        .trigger-name {
            flex-grow: 0;
            flex-shrink: 1;
            min-width: 0;
            overflow: hidden;
            white-space: nowrap;
            text-overflow: ellipsis;
            font-weight: 600;
        }

        .trigger-name.empty {
            font-weight: 400;
            color: ${viraThemeByKeys.grey.foreground.placeholder.foreground.value};
        }

        .trigger-caret {
            flex-grow: 0;
            flex-shrink: 0;
            color: ${viraThemeByKeys.grey.foreground['non-body'].foreground.value};
        }

        .menu-group-header {
            padding: 6px 12px 2px;
            font-size: 10px;
            letter-spacing: 0.06em;
            text-transform: uppercase;
            color: ${viraThemeByKeys.grey.foreground['non-body'].foreground.value};
        }

        .menu-row {
            display: flex;
            align-items: center;
            gap: 10px;
            min-width: 0;
            max-width: 60vw;
        }

        .file-basename {
            flex-grow: 1;
            min-width: 0;
            overflow: hidden;
            white-space: nowrap;
            text-overflow: ellipsis;

            &[data-deleted] {
                text-decoration: line-through;
            }
        }

        /*
         * Fetched lazily from www-static as rows render, so the whole icon set costs nothing until a
         * file that uses one shows up. Sized in px rather than em to stay pixel-aligned with the
         * source svgs, which are drawn on a 32px grid.
         */
        .file-icon {
            flex-grow: 0;
            flex-shrink: 0;
            width: 16px;
            height: 16px;
        }

        /*
         * Desktop file list, the SCM sidebar from VS Code: always visible next to the diff so
         * switching files is one click instead of opening a menu. Mobile keeps the dropdown, since
         * a phone has no width to give away.
         */
        .sidebar {
            display: flex;
            flex-direction: column;
            flex-grow: 0;
            flex-shrink: 0;
            width: var(--sidebar-width);
            min-height: 0;
            overflow: auto;
        }

        /* Same grab behavior as the CLI pane divider: 4px visible, ~14px of hit area. */
        .sidebar-divider {
            position: relative;
            flex-grow: 0;
            flex-shrink: 0;
            width: 4px;
            cursor: col-resize;
            background: ${viraThemeByKeys.grey['behind-bg'].decoration.background.value};
            transition: background 120ms ease;
            z-index: 1;
            touch-action: none;
        }

        .sidebar-divider::before {
            content: '';
            position: absolute;
            top: 0;
            bottom: 0;
            left: -5px;
            right: -5px;
        }

        .sidebar-divider:hover,
        .sidebar-divider[data-dragging] {
            background: ${viraThemeByKeys.grey.foreground.body.foreground.value};
        }

        .sidebar ${ViraCollapsibleCard} {
            display: flex;
            flex-grow: 0;
            flex-shrink: 0;
            ${ViraCollapsibleCard.cssVars['vira-collapsible-card-content-gap'].name}: 0;
        }

        .sidebar-header {
            display: flex;
            align-items: center;
            gap: 4px;
            flex-grow: 1;
            padding: 6px 8px 2px;
            font-size: 10px;
            letter-spacing: 0.06em;
            text-transform: uppercase;
            color: ${viraThemeByKeys.grey.foreground['non-body'].foreground.value};
        }

        .sidebar-header-label {
            flex-grow: 1;
            min-width: 0;
        }

        /*
         * Always visible, unlike the per-row actions: a section header has no row to hover, and
         * these are the buttons most worth reaching for without hunting.
         */
        .header-actions {
            display: flex;
            align-items: center;
            flex-grow: 0;
            flex-shrink: 0;
            gap: 2px;
        }

        .sidebar-row {
            display: flex;
            align-items: center;
            width: 100%;
            box-sizing: border-box;
        }

        .sidebar-row:hover {
            background-color: ${viraThemeByKeys.grey['behind-bg'].invisible.background.value};
        }

        /*
         * Marked rows read as a group without competing with the open file, which keeps its
         * stronger blue. Declared first so the open file wins when it is also marked.
         */
        .sidebar-row[data-marked] {
            background-color: ${viraThemeByKeys.blue['behind-bg'].invisible.background.value};
        }

        .sidebar-row[data-selected] {
            background-color: ${viraThemeByKeys.blue['behind-bg'].decoration.background.value};
        }

        /* Marking files is pointless if the buttons that act on them need a hover to appear. */
        .sidebar-row[data-marked] .row-actions {
            visibility: visible;
        }

        .sidebar-row-open {
            display: flex;
            align-items: center;
            gap: 8px;
            flex-grow: 1;
            min-width: 0;
            padding: 3px 8px;
            appearance: none;
            border: none;
            background: none;
            cursor: pointer;
            font: inherit;
            text-align: left;
            color: inherit;
        }

        /*
         * Hidden by visibility rather than display so the row's width doesn't shift when the
         * pointer arrives — the file name would otherwise reflow under the cursor mid-click.
         */
        .row-actions {
            display: flex;
            align-items: center;
            flex-grow: 0;
            flex-shrink: 0;
            gap: 2px;
            padding-right: 4px;
            visibility: hidden;
        }

        .sidebar-row:hover .row-actions,
        .row-actions:focus-within {
            visibility: visible;
        }

        /*
         * A touch screen has no hover to reveal them with, so hiding them would put staging and
         * discarding out of reach entirely. Keyed on the pointer rather than on viewport width: a
         * narrow desktop window still has a mouse, and a tablet at desktop width still does not.
         */
        @media (hover: none) {
            .row-actions {
                visibility: visible;
            }
        }

        .row-action {
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 2px;
            appearance: none;
            border: none;
            border-radius: 3px;
            background: none;
            cursor: pointer;
            color: ${viraThemeByKeys.grey.foreground['non-body'].foreground.value};
        }

        .row-action:hover:not(:disabled) {
            ${colorCss(viraThemeByKeys.grey.foreground.body)};
        }

        .row-action:disabled {
            cursor: default;
            opacity: 0.4;
        }

        /* Lit up while its side's review is the thing on screen. */
        .row-action[data-active] {
            color: ${viraThemeByKeys.blue.foreground.body.foreground.value};
        }

        /*
         * Staged files have nothing to discard — unstaging is the only move — but the button keeps
         * its space so the stage buttons line up down the whole list.
         */
        .row-action[data-hidden] {
            visibility: hidden;
        }

        .badge {
            flex-grow: 0;
            flex-shrink: 0;
            width: 1em;
            font-weight: 700;
            font-family: 'MesloLGS NF', Menlo, monospace;
        }

        .body {
            position: relative;
            display: flex;
            flex-direction: row;
            flex-grow: 1;
            min-height: 0;
            min-width: 0;
        }

        /*
         * Sideways scrolling belongs to the code pane alone: the editor's own scroller takes it when
         * line wrapping is off, and this host clipping instead of scrolling is what keeps the toolbar,
         * the sidebar, and the ruler from sliding off with it.
         */
        .editor-host {
            flex-grow: 1;
            min-width: 0;
            min-height: 0;
            overflow-x: hidden;
            overflow-y: auto;
        }

        .editor-host[data-hidden] {
            display: none;
        }

        /*
         * Catches the click that dismisses the right-click menu, wherever it lands. Fixed rather
         * than inset in .body so a click outside the pane closes the menu too.
         */
        .menu-backdrop {
            position: fixed;
            inset: 0;
            z-index: 3;
        }

        /*
         * Positioned in viewport coordinates from the pointer that opened it, which is why it is
         * fixed: the pane scrolls and the editor is a scroll container of its own, so anchoring to
         * either would need the offsets recomputed on every scroll.
         */
        .hunk-menu {
            position: fixed;
            z-index: 4;
            display: flex;
            flex-direction: column;
            min-width: 160px;
            padding: 3px;
            border-radius: 5px;
            border: 1px solid ${viraThemeByKeys.grey['behind-bg'].decoration.background.value};
            ${viraShadows.menuShadow}
            ${colorCss(viraThemeByKeys.grey['behind-fg'].body)};
        }

        .hunk-menu button {
            appearance: none;
            border: none;
            background: none;
            padding: 5px 8px;
            border-radius: 3px;
            text-align: left;
            cursor: pointer;
            font: inherit;
            color: inherit;
        }

        .hunk-menu button:hover {
            ${colorCss(viraThemeByKeys.blue.foreground.body)};
        }

        /*
         * Covers the outgoing diff while the next one loads, instead of unmounting the editor and
         * letting the pane collapse to nothing. The editor underneath keeps its width, so the file
         * list and the toolbar don't jump every time a different file is picked.
         */
        .loading-overlay {
            position: absolute;
            inset: 0;
            display: flex;
            align-items: center;
            justify-content: center;
            background: ${viraThemeByKeys.grey['behind-bg'].invisible.background.value};
            opacity: 0.75;
            pointer-events: none;

            & ${ViraIcon} {
                ${spinAnimationCss}
            }
        }

        ${spinKeyframesCss}

        /*
         * Overview ruler, the same idea as VS Code's: a full-height strip where every change in
         * the file gets a mark at its proportional position, so the shape of the diff is visible
         * without scrolling through it.
         */
        .ruler {
            position: relative;
            flex-grow: 0;
            flex-shrink: 0;
            width: 14px;
            border-left: 1px solid ${viraThemeByKeys.grey['behind-bg'].decoration.background.value};
            background: ${viraThemeByKeys.grey['behind-bg'].invisible.background.value};
        }

        .ruler-mark {
            position: absolute;
            left: 2px;
            right: 2px;
            border-radius: 1px;
            cursor: pointer;
            appearance: none;
            border: none;
            padding: 0;
        }

        .ruler-mark:hover {
            left: 0;
            right: 0;
        }

        ${imageDiffStyles}

        .placeholder {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            gap: 12px;
            flex-grow: 1;
            padding: 24px;
            text-align: center;
            color: ${viraThemeByKeys.grey.foreground['non-body'].foreground.value};
        }

        .error {
            color: ${viraThemeByKeys.red.foreground.body.foreground.value};
        }
    `,
    cleanup({state}) {
        state.editor?.destroy();
        state.stopThemeListener?.();
        if (state.refreshTimer) {
            clearInterval(state.refreshTimer);
        }
    },
    render({inputs, state, updateState, host}) {
        const isMobile = inputs.screenSize === ScreenSize.Mobile;
        if (!state.stopThemeListener) {
            updateState({
                stopThemeListener: listenToDarkMode((isDark) => {
                    updateState({
                        isDark,
                    });
                }),
            });
        }
        /** One read per mount; the toolbar toggles keep both values current after that. */
        if (!state.diffSettingsRequested) {
            updateState({
                diffSettingsRequested: true,
            });
            void getConfig().then((config) => {
                updateState({
                    diffLayout: config.diffLayout || DiffLayout.Auto,
                    /** A config written before this field existed reads as undefined, not `false`. */
                    hideWhitespace: config.diffHideWhitespace ?? true,
                });
            });
        }
        const unifiedByLayout: Readonly<Record<DiffLayout, boolean>> = {
            [DiffLayout.Auto]: isMobile,
            [DiffLayout.Split]: false,
            [DiffLayout.Inline]: true,
        };
        const unified = unifiedByLayout[state.diffLayout];
        const selected = findSelected(state.status, state.selectedValue);

        /** The old side as the editor should diff it, which is not the file's real old text. */
        function displayedOldContent(content: Readonly<{oldContent: string; newContent: string}>) {
            return state.hideWhitespace
                ? foldWhitespaceOnlyChanges({
                      oldContent: content.oldContent,
                      newContent: content.newContent,
                  })
                : content.oldContent;
        }

        /**
         * Writes the config so the choice sticks across reloads, and updates the local copy without
         * waiting on the round trip so the toolbar responds immediately.
         */
        function saveDiffSettings(
            nextSettings: Readonly<{diffLayout?: DiffLayout; hideWhitespace?: boolean}>,
        ) {
            updateState(nextSettings);
            void getConfig()
                .then((config) => {
                    return putConfig({
                        ...config,
                        diffLayout: nextSettings.diffLayout ?? state.diffLayout,
                        diffHideWhitespace: nextSettings.hideWhitespace ?? state.hideWhitespace,
                    });
                })
                .catch((error: unknown) => {
                    updateState({
                        statusError: error instanceof Error ? error.message : String(error),
                    });
                });
        }

        /**
         * Re-read status and, if a file is open, its contents. Both writes go through the same
         * content comparison the editor rebuild uses, so a poll that finds nothing new is inert.
         */
        async function refresh(): Promise<void> {
            const folder = inputs.folder;
            const status = await getGitDiffStatus({
                folder,
            }).catch((error: unknown) => {
                updateState({
                    statusError: error instanceof Error ? error.message : String(error),
                });
                return undefined;
            });
            if (!status) {
                return;
            }
            const values = allSelectValues(status);
            const selectedValue = reselectValue(state.selectedValue, values);
            updateState({
                status,
                statusError: undefined,
                selectedValue,
                /**
                 * A marked file that just got staged, discarded, or committed is gone from the list
                 * under its old value, and keeping it marked would aim the next bulk click at a
                 * file the user can no longer see.
                 */
                markedValues: state.markedValues.filter((value) => values.includes(value)),
            });
            /**
             * Every path to a new selection ends in a refresh, so this one write covers them all —
             * including the poll that finds the remembered file gone and picks another.
             */
            if (selectedValue !== rememberedFileForFolder(folder)) {
                rememberFileForFolder({
                    folder,
                    value: selectedValue,
                });
            }

            const nextSelected = findSelected(status, selectedValue);
            if (!nextSelected) {
                updateState({
                    diffContent: undefined,
                });
                return;
            }
            const diffContent = await getGitDiffFile({
                folder,
                path: nextSelected.file.path,
                oldPath: nextSelected.file.oldPath ?? undefined,
                side: nextSelected.side,
                allowLarge: state.allowLargeValues.includes(selectedValue ?? ''),
            }).catch((error: unknown) => {
                updateState({
                    diffError: error instanceof Error ? error.message : String(error),
                });
                return undefined;
            });
            if (diffContent) {
                updateState({
                    diffContent,
                    diffError: undefined,
                });
            }
        }

        if (inputs.active && state.armedFolder !== inputs.folder) {
            if (state.refreshTimer) {
                clearInterval(state.refreshTimer);
            }
            updateState({
                armedFolder: inputs.folder,
                refreshTimer: setInterval(() => {
                    if (!state.busy) {
                        void refresh();
                    }
                }, refreshIntervalMs),
                /**
                 * The refresh below resolves this against the folder's real file list, so a
                 * remembered file that is gone falls back to the first one there.
                 */
                selectedValue: rememberedFileForFolder(inputs.folder),
                /** A different folder's file list and diff must not linger through the reload. */
                ...(state.armedFolder == undefined
                    ? {}
                    : {
                          status: undefined,
                          diffContent: undefined,
                          allowLargeValues: [],
                          markedValues: [],
                          selectionAnchor: undefined,
                          reviewSide: undefined,
                      }),
            });
            void refresh();
        } else if (!inputs.active && state.armedFolder != undefined) {
            if (state.refreshTimer) {
                clearInterval(state.refreshTimer);
            }
            updateState({
                armedFolder: undefined,
                refreshTimer: undefined,
            });
        }

        /**
         * Opt this one file out of the size guard and re-read it. The refresh loop passes
         * `allowLarge` for anything in this list, so the diff also survives the next poll.
         */
        function showLargeDiffAnyway() {
            if (!state.selectedValue) {
                return;
            }
            updateState({
                allowLargeValues: [
                    ...state.allowLargeValues,
                    state.selectedValue,
                ],
                diffContent: undefined,
            });
            void refresh();
        }

        function selectFile(value: string) {
            /**
             * Re-clicking the open file would otherwise clear its content and re-read it, which
             * remounts the editor and throws away the scroll position the user was reading at.
             */
            if (value === state.selectedValue) {
                /** Leaving the review is still the point of the click when it's already open. */
                updateState({
                    reviewSide: undefined,
                });
                return;
            }
            updateState({
                selectedValue: value,
                diffContent: undefined,
                diffError: undefined,
                activeChunkIndex: 0,
                reviewSide: undefined,
            });
            void refresh();
        }

        /**
         * A row click, with the modifier conventions of any other file list: plain opens the file,
         * cmd/ctrl adds or removes one file from the marked set, shift marks everything between the
         * anchor and this row. Only the plain click opens a diff — the whole point of marking files
         * is to line up an action without losing the file being read.
         */
        function onRowClick({event, value}: Readonly<{event: MouseEvent; value: string}>) {
            if (event.shiftKey) {
                const values = allSelectValues(state.status);
                const clickedIndex = values.indexOf(value);
                if (clickedIndex < 0) {
                    return;
                }
                const anchorIndex = values.indexOf(
                    state.selectionAnchor ?? state.selectedValue ?? '',
                );
                /**
                 * Shift dragging out a range leaves the anchor where it was, so widening and
                 * narrowing the range walks from the same end each time.
                 */
                const from = anchorIndex < 0 ? clickedIndex : Math.min(anchorIndex, clickedIndex);
                const to = anchorIndex < 0 ? clickedIndex : Math.max(anchorIndex, clickedIndex);
                /** Shift click also extends the document's text selection, across whole rows. */
                window.getSelection()?.removeAllRanges();
                updateState({
                    markedValues: values.slice(from, to + 1),
                });
            } else if (event.metaKey || event.ctrlKey) {
                /** The first cmd click marks the open file too, since that is the set on screen. */
                const current = state.markedValues.length
                    ? state.markedValues
                    : state.selectedValue
                      ? [state.selectedValue]
                      : [];
                updateState({
                    markedValues: current.includes(value)
                        ? current.filter((marked) => marked !== value)
                        : [
                              ...current,
                              value,
                          ],
                    selectionAnchor: value,
                });
            } else {
                updateState({
                    markedValues: [],
                    selectionAnchor: value,
                });
                selectFile(value);
            }
        }

        /**
         * Files a row's action button applies to: the whole marked set when that row is part of it,
         * and otherwise just that row. Clicking a button on an unmarked row is how the user acts on
         * one file without having to clear the marks first.
         */
        function actionTargets(value: string): SelectedFile[] {
            return (state.markedValues.includes(value) ? state.markedValues : [value])
                .map((target) => findSelected(state.status, target))
                .filter(check.isTruthy);
        }

        /** Run an index write, then immediately re-read so the pane reflects it without waiting. */
        async function runIndexWrite(write: () => Promise<void>): Promise<void> {
            updateState({
                busy: true,
            });
            try {
                await write();
                await refresh();
            } catch (error: unknown) {
                updateState({
                    diffError: error instanceof Error ? error.message : String(error),
                });
            } finally {
                updateState({
                    busy: false,
                });
            }
        }

        /**
         * Each file moves in the direction its own side implies, so a marked set spanning both
         * sides stages the unstaged half and unstages the staged half in one click.
         *
         * Sequential: git takes `index.lock` for the duration of each write, and parallel calls
         * would lose all but one of them to a lock error.
         */
        function onStageWholeFiles(targets: ReadonlyArray<SelectedFile>) {
            void runIndexWrite(async () => {
                await awaitedForEach(targets, async (target) => {
                    await setGitFileStaged({
                        folder: inputs.folder,
                        path: target.file.path,
                        side: target.side,
                    });
                });
            });
        }

        function onStageWholeSide(side: GitDiffSide) {
            void runIndexWrite(async () => {
                await setGitSideStaged({
                    folder: inputs.folder,
                    side,
                });
            });
        }

        /** Confirmed for the same reason {@link onDiscardFiles} is, and over more files. */
        function onDiscardUnstaged() {
            if (
                !window.confirm(
                    [
                        'Discard every unstaged change in this repo?',
                        'This throws away every change that is not staged, deletes untracked files, and cannot be undone. Staged changes are left alone.',
                    ].join('\n\n'),
                )
            ) {
                return;
            }
            void runIndexWrite(async () => {
                await discardUnstagedGitChanges({
                    folder: inputs.folder,
                });
            });
        }

        /**
         * Confirmed, because unlike everything else in this pane it can't be undone from git. The
         * prompt names every file, since a bulk discard is the one action here where a stray marked
         * row costs the user work they can't get back.
         *
         * Paths are deduplicated: discarding throws away both halves of a file, so a file marked on
         * both sides is one discard, not two.
         */
        function onDiscardFiles(targets: ReadonlyArray<SelectedFile>) {
            const paths = Array.from(new Set(targets.map((target) => target.file.path)));
            const firstPath = paths[0];
            if (
                !firstPath ||
                !window.confirm(
                    [
                        paths.length === 1
                            ? `Discard all changes to ${firstPath}?`
                            : [
                                  `Discard all changes to these ${paths.length} files?`,
                                  ...paths,
                              ].join('\n'),
                        'This throws away both staged and unstaged changes and cannot be undone.',
                    ].join('\n\n'),
                )
            ) {
                return;
            }
            void runIndexWrite(async () => {
                /** Sequential for the same `index.lock` reason {@link onStageWholeFiles} is. */
                await awaitedForEach(paths, async (path) => {
                    await discardGitFile({
                        folder: inputs.folder,
                        path,
                    });
                });
            });
        }

        /**
         * The arguments both hunk endpoints take, or undefined when the pane no longer has the file
         * the chunk came from. Chunk offsets are character positions and the endpoints address
         * lines. Converting here (rather than server-side) keeps the server from having to re-run
         * the same diff. The old side has to be the same text the chunks were built from — folding
         * whitespace rewrites line contents, so character offsets only line up against the folded
         * copy.
         *
         * A narrowed selection replaces the new side's range and leaves the old side's alone. That
         * only ever happens for a pure insertion, whose old side is the single point the lines go
         * in at — the same point whichever of them the user picked.
         */
        function toHunkRequest(selection: Readonly<SelectedChunk>) {
            const target = findSelected(state.status, state.selectedValue);
            const content = state.diffContent;
            if (!target || !content) {
                return undefined;
            }
            const oldLines = toLineRange({
                text: Text.of(displayedOldContent(content).split('\n')),
                from: selection.chunk.fromA,
                to: selection.chunk.toA,
            });
            const newLines =
                selection.newLines ??
                toLineRange({
                    text: Text.of(content.newContent.split('\n')),
                    from: selection.chunk.fromB,
                    to: selection.chunk.toB,
                });
            return {
                folder: inputs.folder,
                path: target.file.path,
                oldPath: target.file.oldPath ?? undefined,
                side: target.side,
                fromOldLine: oldLines.from,
                toOldLine: oldLines.to,
                fromNewLine: newLines.from,
                toNewLine: newLines.to,
            };
        }

        /**
         * One request per chunk, bottom of the file upwards. Each request's line numbers were
         * computed against the file as it is now, and writing a chunk shifts every line below it —
         * so working upwards leaves the ranges still to be written untouched, where working
         * downwards would apply the second patch at the wrong offset.
         *
         * Sequential for the same `index.lock` reason {@link onStageWholeFiles} is.
         */
        function toHunkRequests(selections: ReadonlyArray<SelectedChunk>) {
            return selections
                .toSorted((first, second) => second.chunk.fromB - first.chunk.fromB)
                .map((selection) => toHunkRequest(selection))
                .filter(check.isTruthy);
        }

        function onStageChunks(selections: ReadonlyArray<SelectedChunk>) {
            const requests = toHunkRequests(selections);
            if (!requests.length) {
                return;
            }
            void runIndexWrite(async () => {
                await awaitedForEach(requests, async (request) => {
                    await setGitHunkStaged(request);
                });
                /** Landing back on the first chunk avoids pointing at a chunk that just moved. */
                updateState({
                    activeChunkIndex: 0,
                });
            });
        }

        /** Confirmed, because unlike staging this throws the change away for good. */
        function onUndoChunks(selections: ReadonlyArray<SelectedChunk>) {
            const requests = toHunkRequests(selections);
            const scope = stageScopeLabel(selections);
            if (
                !check.isLengthAtLeast(requests, 1) ||
                !window.confirm(
                    [
                        `Undo ${scope.isSingular ? 'this' : 'these'} ${scope.text} in ${requests[0].path}?`,
                        'This throws the change away and cannot be undone.',
                    ].join('\n\n'),
                )
            ) {
                return;
            }
            void runIndexWrite(async () => {
                await awaitedForEach(requests, async (request) => {
                    await discardGitHunk(request);
                });
                updateState({
                    activeChunkIndex: 0,
                });
            });
        }

        function closeHunkMenu() {
            updateState({
                hunkMenu: undefined,
            });
        }

        /**
         * Right-click staging, the way VS Code does it: select any amount of the diff, right-click,
         * and move exactly what the selection covers across the index at once — down to individual
         * added lines, per {@link selectedChunksInRange}.
         *
         * With nothing selected the chunk under the pointer is used rather than the one under the
         * caret, since a right-click doesn't move the caret in every browser — the menu has to act
         * on what the user actually pointed at. A right-click on unchanged code opens the browser's
         * own menu instead, because there is nothing here to offer.
         */
        function onEditorContextMenu(event: MouseEvent) {
            const view = state.editor?.view;
            if (!view || state.busy) {
                return;
            }
            const selection = view.state.selection.main;
            const pointerPosition = view.posAtCoords({
                x: event.clientX,
                y: event.clientY,
            });
            const range =
                selection.empty && pointerPosition != undefined
                    ? {
                          from: pointerPosition,
                          to: pointerPosition,
                      }
                    : {
                          from: selection.from,
                          to: selection.to,
                      };
            const selections = selectedChunksInRange({
                chunks: state.chunks,
                text: view.state.doc,
                ...range,
            });
            if (!selections.length) {
                return;
            }
            event.preventDefault();
            updateState({
                hunkMenu: {
                    x: event.clientX,
                    y: event.clientY,
                    selections,
                },
            });
        }

        /**
         * Rebuild the editor only when what it should display actually changed. Everything else — a
         * poll that found no edits, an unrelated state update — leaves it alone, and with it the
         * user's scroll position.
         */
        const content = state.diffContent;
        const selectedPath = selected?.file.path;
        if (selectedPath && state.syntaxPath !== selectedPath && !state.syntaxLoading) {
            updateState({
                syntaxLoading: true,
            });
            void loadSyntaxExtensions(selectedPath)
                .catch(() => [])
                .then((syntaxExtensions) => {
                    updateState({
                        syntaxExtensions,
                        syntaxPath: selectedPath,
                        syntaxLoading: false,
                    });
                });
        }

        /**
         * An image has no hunks, so the last text file's chunks would otherwise stay armed: the
         * jump buttons would scroll a hidden editor and the ruler would mark a file nobody is
         * looking at. Dropping `rendered` also forces a fresh mount when a text file comes back.
         */
        if (content?.isImage && (state.chunks.length || state.rendered)) {
            updateState({
                chunks: [],
                rulerMarks: [],
                rendered: undefined,
            });
        }

        if (
            state.editorParent &&
            content &&
            !content.tooLargeOrBinary &&
            !content.isImage &&
            state.selectedValue &&
            state.syntaxPath === selectedPath
        ) {
            const nextRendered = {
                value: state.selectedValue,
                oldContent: displayedOldContent(content),
                newContent: content.newContent,
                unified,
                isDark: state.isDark,
                isMobile,
            };
            const previous = state.rendered;
            const changed =
                !previous ||
                previous.value !== nextRendered.value ||
                previous.oldContent !== nextRendered.oldContent ||
                previous.newContent !== nextRendered.newContent ||
                previous.unified !== nextRendered.unified ||
                previous.isDark !== nextRendered.isDark ||
                previous.isMobile !== nextRendered.isMobile;
            if (changed) {
                const oldText = Text.of(nextRendered.oldContent.split('\n'));
                const newText = Text.of(content.newContent.split('\n'));
                const chunks = Chunk.build(oldText, newText, diffConfig);
                state.editor?.destroy();
                state.editorParent.replaceChildren();
                const editor = mountDiffEditor({
                    parent: state.editorParent,
                    root: host.shadowRoot,
                    oldContent: nextRendered.oldContent,
                    newContent: content.newContent,
                    unified,
                    chunks,
                    oldText,
                    newText,
                    side: selected?.side ?? GitDiffSide.Unstaged,
                    syntaxExtensions: state.syntaxExtensions,
                    isDark: state.isDark,
                    isMobile,
                    onStageChunk(chunk) {
                        return onStageChunks([
                            {
                                chunk,
                                newLines: undefined,
                            },
                        ]);
                    },
                    onUndoChunk:
                        selected?.side === GitDiffSide.Staged
                            ? undefined
                            : (chunk) => {
                                  return onUndoChunks([
                                      {
                                          chunk,
                                          newLines: undefined,
                                      },
                                  ]);
                              },
                    onGeometryChange(view) {
                        updateState({
                            rulerMarks: toRulerMarks(view, chunks),
                        });
                    },
                });
                updateState({
                    rendered: nextRendered,
                    chunks,
                    /** Mark positions come from the mounted editor, so they wait for it to exist. */
                    rulerMarks: toRulerMarks(editor.view, chunks),
                    editor,
                });
                /**
                 * A fresh mount starts at line 1, so a change 800 lines into a file opens onto
                 * untouched context. Jump to the first chunk instead — the reason the file is in
                 * the list is what the user came to see.
                 *
                 * Only on a new file, not on every rebuild: a poll that picks up an edit the user
                 * just made in their own editor also rebuilds, and yanking them back to the top of
                 * the file each time would fight them mid-review.
                 */
                const firstChunk = chunks[0];
                if (firstChunk && (!previous || previous.value !== nextRendered.value)) {
                    editor.view.dispatch({
                        effects: EditorView.scrollIntoView(
                            Math.min(firstChunk.fromB, editor.view.state.doc.length),
                            {
                                y: 'start',
                                yMargin: 24,
                            },
                        ),
                    });
                }
            }
        }

        /** Scroll the editor so the given chunk sits at the top of the viewport. */
        function scrollToChunk(index: number) {
            const chunk = state.chunks[index];
            const view = state.editor?.view;
            if (!chunk || !view) {
                return;
            }
            updateState({
                activeChunkIndex: index,
            });
            view.dispatch({
                effects: EditorView.scrollIntoView(Math.min(chunk.fromB, view.state.doc.length), {
                    y: 'start',
                    yMargin: 24,
                }),
            });
        }

        function stepChunk(delta: number) {
            if (!state.chunks.length) {
                return;
            }
            const next = Math.min(
                state.chunks.length - 1,
                Math.max(0, state.activeChunkIndex + delta),
            );
            scrollToChunk(next);
        }

        function stepFile(delta: number) {
            const values = allSelectValues(state.status);
            const current = state.selectedValue ? values.indexOf(state.selectedValue) : -1;
            const next = values[Math.min(values.length - 1, Math.max(0, current + delta))];
            if (next && next !== state.selectedValue) {
                selectFile(next);
            }
        }

        const hasFiles = allSelectValues(state.status).length > 0;
        /** Touch targets need the room; a mouse pointer does not. */
        const buttonSize = isMobile ? ViraSize.Large : ViraSize.Small;

        host.style.setProperty('--sidebar-width', `${state.sidebarWidth}px`);

        /**
         * Sidebar resize, the same pointer-capture drag the CLI panes use. Width is measured from
         * the host's right edge, since the sidebar is what's being sized and it's anchored there.
         */
        function onDividerPointerDown(event: PointerEvent) {
            event.preventDefault();
            const divider = event.currentTarget;
            if (divider instanceof Element) {
                divider.setPointerCapture(event.pointerId);
            }

            const previousUserSelect = document.body.style.userSelect;
            const previousCursor = document.body.style.cursor;
            document.body.style.userSelect = 'none';
            document.body.style.cursor = 'col-resize';

            const latestWidth = {
                value: state.sidebarWidth,
            };
            updateState({
                draggingSidebar: true,
            });

            function onMove(moveEvent: PointerEvent) {
                if (moveEvent.pointerId !== event.pointerId) {
                    return;
                }
                const rect = host.getBoundingClientRect();
                latestWidth.value = Math.min(
                    diffSidebarWidth.max,
                    Math.max(diffSidebarWidth.min, rect.right - moveEvent.clientX),
                );
                updateState({
                    sidebarWidth: latestWidth.value,
                });
            }

            function onUp(upEvent: PointerEvent) {
                if (upEvent.pointerId !== event.pointerId) {
                    return;
                }
                window.removeEventListener('pointermove', onMove);
                window.removeEventListener('pointerup', onUp);
                window.removeEventListener('pointercancel', onUp);
                document.body.style.userSelect = previousUserSelect;
                document.body.style.cursor = previousCursor;
                updateState({
                    draggingSidebar: false,
                });
                localStorageClient.diffSidebarWidth.write(latestWidth.value);
            }

            window.addEventListener('pointermove', onMove);
            window.addEventListener('pointerup', onUp);
            window.addEventListener('pointercancel', onUp);
        }

        /**
         * One collapsible sidebar section. Each side gets its own fixed slot in the parent template
         * even when it's empty, so a file moving across the index can't make lit reuse the staged
         * section's element as the unstaged one and carry its collapsed state along with it.
         */
        /**
         * Bulk buttons in each section's header. `stopPropagation` keeps the click from reaching
         * the collapsible's header, which would otherwise fold the section the button just emptied.
         * The staged side gets no discard-all: unstaging is the way back out of the index, and it
         * loses nothing, so the only bulk discard is the unstaged side's.
         */
        const sideHeaderActions: Readonly<Record<GitDiffSide, () => HtmlInterpolation>> = {
            [GitDiffSide.Unstaged]() {
                return html`
                    <button
                        type="button"
                        class="row-action"
                        title="Discard all unstaged changes"
                        ?disabled=${state.busy}
                        ${listen('click', (event) => {
                            event.stopPropagation();
                            onDiscardUnstaged();
                        })}
                    >
                        <${ViraIcon.assign({
                            icon: revertIcon,
                        })}></${ViraIcon}>
                    </button>
                    <button
                        type="button"
                        class="row-action"
                        title="Stage all changes"
                        ?disabled=${state.busy}
                        ${listen('click', (event) => {
                            event.stopPropagation();
                            onStageWholeSide(GitDiffSide.Unstaged);
                        })}
                    >
                        <${ViraIcon.assign({
                            icon: stageActionIcons[GitDiffSide.Unstaged],
                        })}></${ViraIcon}>
                    </button>
                `;
            },
            [GitDiffSide.Staged]() {
                return html`
                    <button
                        type="button"
                        class="row-action"
                        title="Unstage all changes"
                        ?disabled=${state.busy}
                        ${listen('click', (event) => {
                            event.stopPropagation();
                            onStageWholeSide(GitDiffSide.Staged);
                        })}
                    >
                        <${ViraIcon.assign({
                            icon: stageActionIcons[GitDiffSide.Staged],
                        })}></${ViraIcon}>
                    </button>
                `;
            },
        };

        function toggleReview(side: GitDiffSide) {
            updateState({
                reviewSide: state.reviewSide === side ? undefined : side,
            });
        }

        function reviewButtonTitle(side: GitDiffSide) {
            return state.reviewSide === side
                ? 'Back to the single-file diff'
                : `Read every ${sideLabels[side].toLowerCase()} file's changes in one scroll`;
        }

        function renderReview(side: GitDiffSide) {
            return html`
                <${VirDiffReview.assign({
                    folder: inputs.folder,
                    side,
                    files:
                        (side === GitDiffSide.Staged
                            ? state.status?.staged
                            : state.status?.unstaged) ?? [],
                    hideWhitespace: state.hideWhitespace,
                    isDark: state.isDark,
                })}
                    ${listen(VirDiffReview.events.fileSelected, (event) => {
                        selectFile(toSelectValue(side, event.detail));
                    })}
                ></${VirDiffReview}>
            `;
        }

        function renderSidebarSection(side: GitDiffSide) {
            const files =
                side === GitDiffSide.Staged ? state.status?.staged : state.status?.unstaged;
            if (!files?.length) {
                return '';
            }
            return html`
                <${ViraCollapsibleCard.assign({
                    rawCollapsible: true,
                    startExpanded: !state.collapsedSides[side],
                })}
                    ${listen(ViraCollapsibleCard.events.expandToggle, (event) => {
                        updateState({
                            collapsedSides: {
                                ...state.collapsedSides,
                                [side]: !event.detail,
                            },
                        });
                    })}
                >
                    <div
                        class="sidebar-header"
                        slot=${ViraCollapsibleCard.slotNames['vira-collapsible-card-header']}
                    >
                        <span class="sidebar-header-label">
                            ${sideLabels[side]} (${files.length})
                        </span>
                        <div class="header-actions">
                            <button
                                type="button"
                                class="row-action"
                                ?data-active=${state.reviewSide === side}
                                title=${reviewButtonTitle(side)}
                                ${listen('click', (event) => {
                                    event.stopPropagation();
                                    toggleReview(side);
                                })}
                            >
                                <${ViraIcon.assign({
                                    icon: reviewIcon,
                                })}></${ViraIcon}>
                            </button>
                            ${sideHeaderActions[side]()}
                        </div>
                    </div>
                    ${files.map((file) => {
                        const value = toSelectValue(side, file.path);
                        const rowTargets = actionTargets(value);
                        return html`
                            <div
                                class="sidebar-row"
                                ?data-selected=${value === state.selectedValue}
                                ?data-marked=${state.markedValues.includes(value)}
                            >
                                <button
                                    type="button"
                                    class="sidebar-row-open"
                                    title=${file.path}
                                    ${listen('click', (event) => {
                                        return onRowClick({
                                            event,
                                            value,
                                        });
                                    })}
                                >
                                    ${fileRowContents(file)}
                                </button>
                                <div class="row-actions">
                                    <button
                                        type="button"
                                        class="row-action"
                                        title=${rowTargets.length > 1
                                            ? `Discard all changes to the ${rowTargets.length} selected files`
                                            : 'Discard all changes to this file'}
                                        ?data-hidden=${side === GitDiffSide.Staged}
                                        ?disabled=${state.busy || side === GitDiffSide.Staged}
                                        ${listen('click', () => onDiscardFiles(rowTargets))}
                                    >
                                        <${ViraIcon.assign({
                                            icon: revertIcon,
                                        })}></${ViraIcon}>
                                    </button>
                                    <button
                                        type="button"
                                        class="row-action"
                                        title=${rowTargets.length > 1
                                            ? `${stageActionLabels[side]} the ${rowTargets.length} selected files`
                                            : stageActionLabels[side]}
                                        ?disabled=${state.busy}
                                        ${listen('click', () => onStageWholeFiles(rowTargets))}
                                    >
                                        <${ViraIcon.assign({
                                            icon: stageActionIcons[side],
                                        })}></${ViraIcon}>
                                    </button>
                                </div>
                            </div>
                        `;
                    })}
                </${ViraCollapsibleCard}>
            `;
        }

        return html`
            <div class="toolbar" ?data-mobile=${isMobile}>
                ${isMobile
                    ? html`
                          <${ViraMenuTrigger.assign({
                              isDisabled: !hasFiles,
                          })}
                              class="file-menu"
                          >
                              <button
                                  type="button"
                                  class="file-trigger"
                                  slot=${ViraMenuTrigger.slotNames['vira-menu-trigger-trigger']}
                                  title=${selected?.file.path || 'No changes'}
                                  ?disabled=${!hasFiles}
                              >
                                  ${selected
                                      ? html`
                                            <img
                                                class="file-icon"
                                                src=${toFileIconUrl(selected.file.path)}
                                                alt=""
                                            />
                                            <span class="trigger-name">
                                                ${basename(selected.file.path)}
                                            </span>
                                            <span
                                                class="badge"
                                                style=${css`
                                                    color: ${changeBadgeColors[
                                                        selected.file.change
                                                    ]};
                                                `}
                                            >
                                                ${changeBadges[selected.file.change]}
                                            </span>
                                        `
                                      : html`
                                            <span class="trigger-name empty">
                                                ${hasFiles ? 'Select a file' : 'No changes'}
                                            </span>
                                        `}
                                  <${ViraIcon.assign({
                                      icon: caretIcon,
                                  })}
                                      class="trigger-caret"
                                  ></${ViraIcon}>
                              </button>
                              ${toMenuGroups(state.status).map((group) => {
                                  return html`
                                      <div class="menu-group-header">
                                          ${sideLabels[group.side]} (${group.files.length})
                                      </div>
                                      <${ViraMenuItem.assign({
                                          selected: state.reviewSide === group.side,
                                      })}
                                          ${listen(ViraMenuItem.events.activate, () => {
                                              return toggleReview(group.side);
                                          })}
                                      >
                                          <div
                                              class="menu-row"
                                              title=${reviewButtonTitle(group.side)}
                                          >
                                              <${ViraIcon.assign({
                                                  icon: reviewIcon,
                                              })}></${ViraIcon}>
                                              <span class="file-basename">
                                                  Review all ${group.files.length}
                                              </span>
                                          </div>
                                      </${ViraMenuItem}>
                                      ${group.files.map((file) => {
                                          const value = toSelectValue(group.side, file.path);
                                          return html`
                                              <${ViraMenuItem.assign({
                                                  selected: value === state.selectedValue,
                                              })}
                                                  ${listen(ViraMenuItem.events.activate, () => {
                                                      return selectFile(value);
                                                  })}
                                              >
                                                  <div class="menu-row" title=${file.path}>
                                                      ${fileRowContents(file)}
                                                  </div>
                                              </${ViraMenuItem}>
                                          `;
                                      })}
                                  `;
                              })}
                          </${ViraMenuTrigger}>
                      `
                    : ''}
                <div class="toolbar-actions">
                    <div class="toolbar-group">
                        <${ViraButton.assign({
                            icon: LucideChevronLeftIcon,
                            buttonSize,
                            buttonEmphasis: ViraEmphasis.Subtle,
                            color: ViraColorVariant.Plain,
                            isDisabled: !hasFiles,
                        })}
                            title="Previous file"
                            ${listen('click', () => stepFile(-1))}
                        ></${ViraButton}>
                        <${ViraButton.assign({
                            icon: LucideChevronRightIcon,
                            buttonSize,
                            buttonEmphasis: ViraEmphasis.Subtle,
                            color: ViraColorVariant.Plain,
                            isDisabled: !hasFiles,
                        })}
                            title="Next file"
                            ${listen('click', () => stepFile(1))}
                        ></${ViraButton}>
                    </div>
                    <div class="toolbar-group">
                        <${ViraButton.assign({
                            icon: LucideChevronUpIcon,
                            buttonSize,
                            buttonEmphasis: ViraEmphasis.Subtle,
                            color: ViraColorVariant.Plain,
                            isDisabled: !state.chunks.length,
                        })}
                            title="Previous change"
                            ${listen('click', () => stepChunk(-1))}
                        ></${ViraButton}>
                        <${ViraButton.assign({
                            icon: LucideChevronDownIcon,
                            buttonSize,
                            buttonEmphasis: ViraEmphasis.Subtle,
                            color: ViraColorVariant.Plain,
                            isDisabled: !state.chunks.length,
                        })}
                            title="Next change"
                            ${listen('click', () => stepChunk(1))}
                        ></${ViraButton}>
                    </div>
                    <${ViraButton.assign({
                        icon: unified ? splitLayoutIcon : inlineLayoutIcon,
                        buttonSize,
                        buttonEmphasis: ViraEmphasis.Subtle,
                        color: ViraColorVariant.Plain,
                    })}
                        title=${unified ? 'Switch to side-by-side' : 'Switch to inline'}
                        ${listen('click', () => {
                            return saveDiffSettings({
                                diffLayout: unified ? DiffLayout.Split : DiffLayout.Inline,
                            });
                        })}
                    ></${ViraButton}>
                    <${ViraButton.assign({
                        icon: whitespaceIcon,
                        buttonSize,
                        buttonEmphasis: ViraEmphasis.Subtle,
                        /**
                         * Lit up while whitespace changes are showing, since hiding them is the
                         * default.
                         */
                        color: state.hideWhitespace
                            ? ViraColorVariant.Plain
                            : ViraColorVariant.Info,
                    })}
                        title=${state.hideWhitespace
                            ? 'Whitespace-only changes are hidden. Click to show them.'
                            : 'Whitespace-only changes are shown. Click to hide them.'}
                        ${listen('click', () => {
                            return saveDiffSettings({
                                hideWhitespace: !state.hideWhitespace,
                            });
                        })}
                    ></${ViraButton}>
                    <${ViraButton.assign({
                        text: selected ? stageActionLabels[selected.side] : 'Stage',
                        buttonSize,
                        color: ViraColorVariant.Neutral,
                        isDisabled: !selected || state.busy,
                    })}
                        title="Move the whole file across the index"
                        ${listen('click', () => {
                            if (!selected) {
                                return;
                            }
                            /**
                             * Moved before the write, whose own refresh then carries this selection
                             * forward. Reading the current status first is what makes the next file
                             * findable — a moment later the file being staged is gone from this
                             * side.
                             */
                            const nextValue = nextSideValue(state.status, selected);
                            if (nextValue) {
                                updateState({
                                    selectedValue: nextValue,
                                    diffContent: undefined,
                                    diffError: undefined,
                                    activeChunkIndex: 0,
                                });
                            }
                            onStageWholeFiles([
                                selected,
                            ]);
                        })}
                    ></${ViraButton}>
                </div>
            </div>
            ${selected && !state.reviewSide
                ? html`
                      <div class="selected-path" title=${selected.file.path}>
                          ${selected.file.path}
                      </div>
                  `
                : ''}
            <div class="body">
                ${state.reviewSide
                    ? renderReview(state.reviewSide)
                    : state.statusError || state.diffError
                      ? html`
                            <div class="placeholder error">
                                ${state.statusError || state.diffError}
                            </div>
                        `
                      : hasFiles
                        ? selected
                            ? content?.tooLargeOrBinary
                                ? html`
                                      <div class="placeholder">
                                          ${content.canShowAnyway
                                              ? `Over ${maxDiffFileLines} lines — diffing it can lock the page up for a while.`
                                              : 'Binary or oversized file — no diff shown.'}
                                          ${content.canShowAnyway
                                              ? html`
                                                    <${ViraButton.assign({
                                                        text: 'Show diff anyway',
                                                        buttonSize: ViraSize.Small,
                                                        color: ViraColorVariant.Neutral,
                                                    })}
                                                        ${listen('click', showLargeDiffAnyway)}
                                                    ></${ViraButton}>
                                                `
                                              : ''}
                                      </div>
                                  `
                                : content?.isImage
                                  ? renderImageDiff({
                                        content,
                                    })
                                  : ''
                            : html`
                                  <div class="placeholder">Select a file to see its diff.</div>
                              `
                        : html`
                              <div class="placeholder">No changes in this folder.</div>
                          `}
                <div
                    class="editor-host"
                    ?data-hidden=${!!state.reviewSide ||
                    !selected ||
                    content?.tooLargeOrBinary ||
                    content?.isImage}
                    ${listen('contextmenu', onEditorContextMenu)}
                    ${onDomCreated((element) => {
                        if (element instanceof HTMLElement && !state.editorParent) {
                            updateState({
                                editorParent: element,
                            });
                        }
                    })}
                ></div>
                ${state.hunkMenu && selected
                    ? html`
                          <div
                              class="menu-backdrop"
                              ${listen('pointerdown', closeHunkMenu)}
                              ${listen('contextmenu', (event) => {
                                  event.preventDefault();
                                  closeHunkMenu();
                              })}
                          ></div>
                          <div
                              class="hunk-menu"
                              style=${css`
                                  left: ${state.hunkMenu.x}px;
                                  top: ${state.hunkMenu.y}px;
                              `}
                          >
                              <button
                                  type="button"
                                  ${listen('click', () => {
                                      const selections = state.hunkMenu?.selections ?? [];
                                      closeHunkMenu();
                                      onStageChunks(selections);
                                  })}
                              >
                                  ${stageActionLabels[selected.side]}
                                  ${stageScopeLabel(state.hunkMenu.selections).text}
                              </button>
                              ${selected.side === GitDiffSide.Unstaged
                                  ? html`
                                        <button
                                            type="button"
                                            ${listen('click', () => {
                                                const selections = state.hunkMenu?.selections ?? [];
                                                closeHunkMenu();
                                                onUndoChunks(selections);
                                            })}
                                        >
                                            Undo ${stageScopeLabel(state.hunkMenu.selections).text}
                                        </button>
                                    `
                                  : ''}
                          </div>
                      `
                    : ''}
                ${selected && !content && !state.diffError && !state.reviewSide
                    ? html`
                          <div class="loading-overlay">
                              <${ViraIcon.assign({
                                  icon: loaderIcon,
                              })}></${ViraIcon}>
                          </div>
                      `
                    : ''}
                ${state.rulerMarks.length &&
                content &&
                !content.tooLargeOrBinary &&
                !content.isImage &&
                !state.reviewSide
                    ? html`
                          <div class="ruler">
                              ${state.rulerMarks.map((mark, index) => {
                                  return html`
                                      <button
                                          type="button"
                                          class="ruler-mark"
                                          title="Jump to change ${index + 1}"
                                          style=${css`
                                              top: ${mark.topPercent}%;
                                              height: ${mark.heightPercent}%;
                                              background: ${mark.color};
                                          `}
                                          ${listen('click', () => scrollToChunk(index))}
                                      ></button>
                                  `;
                              })}
                          </div>
                      `
                    : ''}
                ${isMobile || !hasFiles
                    ? ''
                    : html`
                          <div
                              class="sidebar-divider"
                              ?data-dragging=${state.draggingSidebar}
                              title="Drag to resize. Double-click to reset."
                              ${listen('pointerdown', onDividerPointerDown)}
                              ${listen('dblclick', () => {
                                  updateState({
                                      sidebarWidth: diffSidebarWidth.default,
                                  });
                                  localStorageClient.diffSidebarWidth.write(
                                      diffSidebarWidth.default,
                                  );
                              })}
                          ></div>
                          <div class="sidebar">
                              ${renderSidebarSection(GitDiffSide.Staged)}
                              ${renderSidebarSection(GitDiffSide.Unstaged)}
                          </div>
                      `}
            </div>
        `;
    },
});
