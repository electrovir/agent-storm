// cspell:words keymap menlo

import {type ReviewComment} from '@agent-storm/common';
import {assertWrap} from '@augment-vir/assert';
import {createArray, getObjectTypedKeys} from '@augment-vir/common';
import {defaultKeymap, history, historyKeymap} from '@codemirror/commands';
import {bracketMatching, foldGutter} from '@codemirror/language';
import {Chunk, MergeView, unifiedMergeView} from '@codemirror/merge';
import {EditorState, Text, type Extension, type Line} from '@codemirror/state';
import {
    Decoration,
    EditorView,
    ViewPlugin,
    highlightActiveLineGutter,
    keymap,
    lineNumbers,
    type ViewUpdate,
} from '@codemirror/view';
import {colorsFor} from '../../util/diff-colors.js';
import {foldWhitespaceOnlyChanges} from '../../util/diff-whitespace.js';
import {diffConfig} from '../../util/vscode-diff.js';
import {editorSurfaceColors} from './diff-editor-colors.js';
import {
    commentingLineField,
    reviewCommentExtension,
    setCommentingLineEffect,
    setReviewCommentsEffect,
    type DiffCommentHandlers,
} from './diff-editor-comments.js';
import {collapsedGapsExtension} from './diff-editor-gaps.js';

/**
 * Columns a wrapped row hangs by, so a continuation reads as part of the line above it rather than
 * as a new statement at column zero.
 */
const hangingIndentColumns = 4;

/**
 * Shared read-only editor extensions. Deliberately minimal: the point of replacing the embedded VS
 * Code is that a phone shouldn't pay for an IDE to read a diff.
 */
function baseExtensions({isDark, isMobile}: Readonly<{isDark: boolean; isMobile: boolean}>) {
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
}>) {
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
}: Readonly<{chunk: Readonly<Chunk>; text: Text; isOldSide: boolean}>) {
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
}>) {
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
function deletedLineFlattenExtension() {
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
                            const withoutDeletedText = assertWrap.instanceOf(
                                line.cloneNode(true),
                                Element,
                            );
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
function deletionColorTheme(isDark: boolean) {
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

function insertionColorTheme(isDark: boolean) {
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
function unifiedColorTheme(isDark: boolean) {
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
    collapseUnchanged,
    chunks,
    oldText,
    newText,
    syntaxExtensions,
    isDark,
    isMobile,
    commentHandlers,
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
    /** Fold long unchanged runs between chunks behind a bar with expand buttons. */
    collapseUnchanged: boolean;
    chunks: ReadonlyArray<Chunk>;
    /** Both sides as {@link Text}, which the caller already built to diff them. */
    oldText: Text;
    newText: Text;
    /** Grammar plus highlight style for this file's type, already resolved by the caller. */
    syntaxExtensions: ReadonlyArray<Extension>;
    /**
     * Theme mode to build the editor for. A change remounts the editor rather than reconfiguring
     * it: the merge view holds two editors plus its own gutter, and the mode changes about as often
     * as the user changes their mind about it.
     */
    isDark: boolean;
    /**
     * Touch layout: bigger comment buttons, and a horizontally scrolling code pane instead of
     * wrapped lines. Independent of `unified`, which the user can force on either screen size.
     */
    isMobile: boolean;
    /** Omitted for a diff that takes no review comments: no comment buttons, no comments drawn. */
    commentHandlers?: DiffCommentHandlers | undefined;
    /**
     * Fired whenever the new side's layout changes — a resize, a width drag, anything that re-wraps
     * lines. The ruler's marks are pixel positions, so they go stale exactly when this fires.
     */
    onGeometryChange?: ((view: EditorView) => void) | undefined;
}>) {
    const reviewComments = commentHandlers
        ? reviewCommentExtension({
              isDark,
              isMobile,
              ...commentHandlers,
          })
        : [];
    const geometryListener = EditorView.updateListener.of((update) => {
        if (update.geometryChanged) {
            onGeometryChange?.(update.view);
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
                reviewComments,
                geometryListener,
                unifiedMergeView({
                    original: oldContent,
                    /** Read-only pane: there is nothing to revert a chunk into. */
                    mergeControls: false,
                    diffConfig,
                }),
                ...(collapseUnchanged ? collapsedGapsExtension(isDark) : []),
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
                ...(collapseUnchanged ? collapsedGapsExtension(isDark) : []),
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
                reviewComments,
                geometryListener,
                ...(collapseUnchanged ? collapsedGapsExtension(isDark) : []),
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
 * Everything the mounted editor displays. A change to any of it remounts the editor, and a poll
 * that changes none of it leaves the editor, and the reader's scroll position in it, alone.
 */
export type DiffEditorDisplay = Readonly<{
    /**
     * Which file is shown, so two files with identical contents still remount with their own
     * comment handlers.
     */
    fileKey: string;
    oldContent: string;
    newContent: string;
    unified: boolean;
    collapseUnchanged: boolean;
    isDark: boolean;
    isMobile: boolean;
    syntaxExtensions: ReadonlyArray<Extension>;
    enableComments: boolean;
}>;

/** What {@link remountChangedDiffEditor} mounted, and the diff it built to do so. */
export type RenderedDiff = DiffEditorDisplay &
    Readonly<{
        chunks: ReadonlyArray<Chunk>;
        /** Both sides as {@link Text}, which the chunk offsets index into. */
        oldText: Text;
        newText: Text;
        /** Undefined when `skipEmptyDiff` left a diff with no changes unmounted. */
        editor: ReturnType<typeof mountDiffEditor> | undefined;
        /** The comments the editor was last handed, serialized, so an unchanged poll is inert. */
        shownCommentsKey: string | undefined;
    }>;

/**
 * Mounts the diff editor into `parent` in place of whatever is there, unless `rendered` already
 * shows exactly `display`.
 *
 * @returns The new rendered diff, or undefined when nothing changed and the editor was left alone.
 */
export function remountChangedDiffEditor({
    parent,
    root,
    rendered,
    display,
    skipEmptyDiff,
    commentHandlers,
    onGeometryChange,
}: Readonly<{
    parent: HTMLElement;
    /** The shadow root `parent` lives in, which CodeMirror measures against. */
    root: ShadowRoot;
    rendered: RenderedDiff | undefined;
    display: DiffEditorDisplay;
    /** Leave a diff with no changes unmounted, for a caller that shows a note in its place. */
    skipEmptyDiff?: boolean | undefined;
    /** Only wired up when `display.enableComments` is set. */
    commentHandlers: DiffCommentHandlers;
    /** The chunks are the ones this mount built, which go stale along with their positions. */
    onGeometryChange?: ((view: EditorView, chunks: ReadonlyArray<Chunk>) => void) | undefined;
}>) {
    if (rendered && getObjectTypedKeys(display).every((key) => rendered[key] === display[key])) {
        return undefined;
    }
    const oldText = Text.of(display.oldContent.split('\n'));
    const newText = Text.of(display.newContent.split('\n'));
    const chunks = Chunk.build(oldText, newText, diffConfig);
    rendered?.editor?.destroy();
    parent.replaceChildren();
    return {
        ...display,
        chunks,
        oldText,
        newText,
        shownCommentsKey: undefined,
        editor:
            skipEmptyDiff && !chunks.length
                ? undefined
                : mountDiffEditor({
                      parent,
                      root,
                      oldContent: display.oldContent,
                      newContent: display.newContent,
                      unified: display.unified,
                      collapseUnchanged: display.collapseUnchanged,
                      chunks,
                      oldText,
                      newText,
                      syntaxExtensions: display.syntaxExtensions,
                      isDark: display.isDark,
                      isMobile: display.isMobile,
                      commentHandlers: display.enableComments ? commentHandlers : undefined,
                      onGeometryChange(view) {
                          onGeometryChange?.(view, chunks);
                      },
                  }),
    };
}

/**
 * Highlights the line the comment composer is writing about and draws `comments` under their lines,
 * dispatching only what changed.
 *
 * @returns `rendered` with `comments` recorded as shown, or undefined when they already were.
 */
export function syncDiffEditorComments({
    rendered,
    commentingLine,
    comments,
}: Readonly<{
    rendered: RenderedDiff | undefined;
    commentingLine: number | undefined;
    comments: ReadonlyArray<ReviewComment>;
}>) {
    const view = rendered?.editor?.view;
    if (!rendered || !view) {
        return undefined;
    }
    if (view.state.field(commentingLineField, false) !== commentingLine) {
        view.dispatch({
            effects: setCommentingLineEffect.of(commentingLine),
        });
    }
    const commentsKey = JSON.stringify(comments);
    if (rendered.shownCommentsKey === commentsKey) {
        return undefined;
    }
    view.dispatch({
        effects: setReviewCommentsEffect.of(comments),
    });
    return {
        ...rendered,
        shownCommentsKey: commentsKey,
    };
}

/**
 * Each loaded diff's whitespace-folded old side. Folding runs a full line diff, and the pane
 * re-renders on every editor geometry change while scrolling, so recomputing it per render stalls
 * the scroll. Keyed by the fetched contents object, so it runs once per fetch instead.
 */
const foldedOldContents = new WeakMap<Readonly<{oldContent: string; newContent: string}>, string>();

/** The old side as the editor should diff it, which is not the file's real old text. */
export function toDisplayedOldContent({
    content,
    hideWhitespace,
}: Readonly<{
    content: Readonly<{oldContent: string; newContent: string}>;
    hideWhitespace: boolean;
}>) {
    if (!hideWhitespace) {
        return content.oldContent;
    }
    const cached = foldedOldContents.get(content);
    if (cached != undefined) {
        return cached;
    }
    const folded = foldWhitespaceOnlyChanges({
        oldContent: content.oldContent,
        newContent: content.newContent,
    });
    foldedOldContents.set(content, folded);
    return folded;
}
