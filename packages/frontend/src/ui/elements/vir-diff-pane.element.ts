// cspell:words keymap, Meslo, Menlo, Pilcrow, unstaging, desaturated

import {
    DiffLayout,
    GitDiffSide,
    GitFileChange,
    maxDiffFileLines,
    type GitDiffFile,
    type GitDiffFileContents,
    type GitDiffStatus,
} from '@agent-storm/common';
import {extractExtension} from '@augment-vir/common';
import {defaultKeymap, history, historyKeymap} from '@codemirror/commands';
import {bracketMatching, foldGutter} from '@codemirror/language';
import {Chunk, MergeView, unifiedMergeView} from '@codemirror/merge';
import {EditorState, Text, type Extension} from '@codemirror/state';
import {
    Decoration,
    EditorView,
    WidgetType,
    highlightActiveLineGutter,
    keymap,
    lineNumbers,
    type DecorationSet,
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
    HorizontalAnchor,
    LoaderAnimated24Icon,
    ViraButton,
    ViraCollapsibleCard,
    ViraColorVariant,
    ViraEmphasis,
    ViraIcon,
    ViraMenuItem,
    ViraMenuTrigger,
    ViraSize,
    createSizedIcon,
    lucideIcons,
    viraThemeByKeys,
    type ViraIconSvg,
} from 'vira';
import {
    discardAllGitChanges,
    discardGitFile,
    discardGitHunk,
    getConfig,
    getGitDiffFile,
    getGitDiffStatus,
    putConfig,
    setGitFileStaged,
    setGitHunkStaged,
    setGitSideStaged,
} from '../../util/api-client.js';
import {reportRenderError} from '../../util/client-error-log.js';
import {loadSyntaxExtensions} from '../../util/diff-syntax.js';
import {toFileIconUrl} from '../../util/file-icon.js';
import {diffSidebarWidth, localStorageClient} from '../../util/local-storage-client.js';
import {ScreenSize} from '../../util/screen-size.js';
import {isDarkMode, listenToDarkMode} from '../../util/theme-mode.js';
import {diffConfig, diffLines} from '../../util/vscode-diff.js';

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

const caretIcon = createSizedIcon(lucideIcons.ChevronDown, 14);

const revertIcon = createSizedIcon(lucideIcons.Undo2, 14);

/** Toolbar toggles read as settings rather than actions, so they sit a size below the nav arrows. */
const splitLayoutIcon = createSizedIcon(lucideIcons.Columns2, 12);
const inlineLayoutIcon = createSizedIcon(lucideIcons.Rows2, 12);
const whitespaceIcon = createSizedIcon(lucideIcons.Pilcrow, 12);

/** Direction the row's stage button moves the file, matching {@link stageActionLabels}. */
const stageActionIcons: Readonly<Record<GitDiffSide, ViraIconSvg>> = {
    [GitDiffSide.Staged]: createSizedIcon(lucideIcons.Minus, 14),
    [GitDiffSide.Unstaged]: createSizedIcon(lucideIcons.Plus, 14),
};

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

/** Same wording, scoped to a single chunk, for the button rendered above each one. */
const stageLabels: Readonly<Record<GitDiffSide, string>> = {
    [GitDiffSide.Staged]: 'Unstage hunk',
    [GitDiffSide.Unstaged]: 'Stage hunk',
};

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
        <span class="file-basename">${basename(file.path)}</span>
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
 * The old side of the diff with whitespace-only differences erased, matching `git diff -w`.
 *
 * Every old line that pairs with a new line differing only in spacing is replaced by that new
 * line's exact text, so CodeMirror's own diff finds nothing to mark there. Rewriting the text is
 * what makes this work everywhere at once — the marks, the change count, the jump buttons, and the
 * ruler all derive from that diff, so none of them need to know about the setting. Line count is
 * untouched, which keeps hunk staging's line math valid.
 */
function foldWhitespaceOnlyChanges({
    oldContent,
    newContent,
}: Readonly<{
    oldContent: string;
    newContent: string;
}>): string {
    const oldLines = oldContent.split('\n');
    const newLines = newContent.split('\n');
    const normalize = (line: string) => line.replace(/\s+/g, '');
    const changes = diffLines({
        aLines: oldLines.map(normalize),
        bLines: newLines.map(normalize),
    });
    /**
     * The diff reports what changed, so the aligned-and-equal runs are the gaps between its
     * changes, plus the tail after the last one.
     */
    const alignedRuns = [
        ...changes,
        undefined,
    ].map((change, index) => {
        const previous = changes[index - 1];
        const fromA = previous?.toA ?? 0;
        return {
            fromA,
            fromB: previous?.toB ?? 0,
            length: (change?.fromA ?? oldLines.length) - fromA,
        };
    });
    const foldedByLine = new Map<number, string>(
        alignedRuns.flatMap(({fromA, fromB, length}) =>
            newLines.slice(fromB, fromB + length).map((line, offset) => {
                return [
                    fromA + offset,
                    line,
                ] as const;
            }),
        ),
    );
    return oldLines.map((line, index) => foldedByLine.get(index) ?? line).join('\n');
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
function baseExtensions(isDark: boolean): ReadonlyArray<Extension> {
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
        EditorView.lineWrapping,
        EditorState.readOnly.of(true),
        /*
         * The `dark` flag is what switches CodeMirror's own base theme — gutter background, active
         * line, fold markers — between its light and dark rules. It keys off a class the editor
         * only gets when a registered theme declares itself dark, so without this the gutters stay
         * the light theme's near-white no matter what the rest of the app is doing.
         */
        EditorView.theme(
            {
                '&': {
                    height: '100%',
                    fontSize: '12px',
                },
                '.cm-scroller': {
                    fontFamily: '"MesloLGS NF", Menlo, monospace',
                },
                /*
                 * The hanging indent is one flat amount for every line, applied in CSS. Matching
                 * each line's own indent instead would take a per-line decoration, and a decoration
                 * that changes how a line wraps changes its height — which is the number the
                 * side-by-side layout aligns its two editors on. When those heights were per line,
                 * the aligner drifted and the new side rendered no text at all.
                 */
                '.cm-line': {
                    paddingLeft: `${hangingIndentColumns}ch`,
                    textIndent: `-${hangingIndentColumns}ch`,
                },
            },
            {
                dark: isDark,
            },
        ),
    ];
}

/**
 * CodeMirror's stock merge colors are a few percent of tint and wash out entirely on a bright
 * screen. These are strong enough to find by scanning, and the side-by-side and inline layouts use
 * the same four values so a file looks the same either way.
 *
 * Two layers: every changed line gets a pale tint so the extent of the change is visible at a
 * glance, and the words CodeMirror narrowed the edit down to sit on top in a darker shade. Both are
 * desaturated versions of Claude Code's own diff colors, which read as too vivid over a full screen
 * of code.
 *
 * All four are opaque on purpose. A translucent tint composites once per element that carries it,
 * and CodeMirror nests a changed-text span inside a changed line inside (in the unified view) a
 * deleted chunk — so an alpha that looked right in isolation stacked two or three deep and came out
 * far darker than intended. Opaque colors render as written no matter how they nest.
 */
type DiffColors = {
    removedLine: string;
    removedText: string;
    removedChunk: string;
    addedLine: string;
    addedText: string;
};

/**
 * The dark set is the light set's job done from the other end: dark enough that the code on top
 * keeps its contrast, tinted enough to find by scanning. The pale tints that work on white read as
 * glowing panels over a dark editor, which is why they aren't simply reused at a lower opacity.
 */
const diffColors: Readonly<Record<'light' | 'dark', Readonly<DiffColors>>> = {
    light: {
        removedLine: '#fbe9e9',
        removedText: '#f5cfcf',
        removedChunk: '#fdf4f4',
        addedLine: '#e7f7e5',
        addedText: '#cbeec7',
    },
    dark: {
        removedLine: '#3a2326',
        removedText: '#5c2f34',
        removedChunk: '#2a1c1e',
        addedLine: '#1d3524',
        addedText: '#2b5334',
    },
};

function colorsFor(isDark: boolean): Readonly<DiffColors> {
    return isDark ? diffColors.dark : diffColors.light;
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
    });
}

const undoHunkLabel = 'Undo hunk';

/**
 * The buttons rendered above a chunk: move that chunk across the index, and — only for a chunk that
 * isn't staged yet — throw it away. A staged chunk gets no undo button because unstaging it is the
 * reversible way back to the same place, and the destructive one is a click away from there.
 */
class HunkStageWidget extends WidgetType {
    constructor(
        protected readonly label: string,
        protected readonly onStage: () => void,
        protected readonly onUndo: (() => void) | undefined,
    ) {
        super();
    }

    public override eq(other: HunkStageWidget): boolean {
        return other.label === this.label;
    }

    public override toDOM(): HTMLElement {
        const wrapper = document.createElement('div');
        wrapper.className = 'agent-storm-hunk-actions';
        const onUndo = this.onUndo;
        wrapper.append(
            ...(onUndo ? [this.buildButton(undoHunkLabel, onUndo)] : []),
            this.buildButton(this.label, this.onStage),
        );
        return wrapper;
    }

    protected buildButton(label: string, onClick: () => void): HTMLButtonElement {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = label;
        button.addEventListener('click', (event) => {
            event.preventDefault();
            onClick();
        });
        return button;
    }

    /** Without this the editor swallows the click before the button's own listener sees it. */
    public override ignoreEvent(): boolean {
        return false;
    }
}

function hunkButtonExtension({
    chunks,
    newText,
    label,
    isDark,
    onStageChunk,
    onUndoChunk,
}: Readonly<{
    chunks: ReadonlyArray<Chunk>;
    newText: Text;
    label: string;
    isDark: boolean;
    onStageChunk: (chunk: Readonly<Chunk>) => void;
    /** Undefined for a staged chunk, which shows no undo button. */
    onUndoChunk: ((chunk: Readonly<Chunk>) => void) | undefined;
}>): Extension {
    const decorations: DecorationSet = Decoration.set(
        chunks.map((chunk) => {
            /**
             * Anchor at the start of the chunk's first line in the new document. A pure deletion
             * has no lines there, in which case `fromB` is the join point and the button lands
             * where the removed text would have been.
             */
            const position = newText.lineAt(Math.min(chunk.fromB, newText.length)).from;
            return Decoration.widget({
                widget: new HunkStageWidget(
                    label,
                    () => onStageChunk(chunk),
                    onUndoChunk && (() => onUndoChunk(chunk)),
                ),
                side: -1,
                block: true,
            }).range(position);
        }),
        true,
    );
    return [
        EditorView.decorations.of(decorations),
        EditorView.theme({
            '.agent-storm-hunk-actions': {
                display: 'flex',
                justifyContent: 'flex-end',
                gap: '4px',
                padding: '1px 6px',
            },
            '.agent-storm-hunk-actions button': {
                font: 'inherit',
                fontSize: '10px',
                lineHeight: '1',
                padding: '2px 8px',
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
    newText,
    stageLabel,
    syntaxExtensions,
    isDark,
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
    newText: Text;
    stageLabel: string;
    /** Grammar plus highlight style for this file's type, already resolved by the caller. */
    syntaxExtensions: ReadonlyArray<Extension>;
    /**
     * Theme mode to build the editor for. A change remounts the editor rather than reconfiguring
     * it: the merge view holds two editors plus its own gutter, and the mode changes about as often
     * as the user changes their mind about it.
     */
    isDark: boolean;
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
        label: stageLabel,
        isDark,
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
                ...baseExtensions(isDark),
                ...syntaxExtensions,
                unifiedColorTheme(isDark),
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
            destroy: () => view.destroy(),
        };
    }
    const merge = new MergeView({
        parent,
        root,
        a: {
            doc: oldContent,
            extensions: [
                ...baseExtensions(isDark),
                ...syntaxExtensions,
                deletionColorTheme(isDark),
            ],
        },
        b: {
            doc: newContent,
            extensions: [
                ...baseExtensions(isDark),
                ...syntaxExtensions,
                insertionColorTheme(isDark),
                hunkButtons,
                geometryListener,
            ],
        },
        gutter: true,
        diffConfig,
    });
    return {
        view: merge.b,
        destroy: () => merge.destroy(),
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

/** One mark on the overview ruler: where a chunk sits in the file and what kind of change it is. */
type RulerMark = {
    topPercent: number;
    heightPercent: number;
    color: CSSResult;
};

/**
 * Ruler marks reuse the diff body's red and green so the overview reads as the same information at
 * a smaller scale. A replacement is both a removal and an addition, so its mark is split rather
 * than given a third color that has to be learned.
 */
const rulerColors = {
    inserted: unsafeCSS('rgba(106, 194, 43, 0.85)'),
    deleted: unsafeCSS('rgba(248, 81, 73, 0.85)'),
    modified: unsafeCSS(
        'linear-gradient(rgba(248, 81, 73, 0.85) 50%, rgba(106, 194, 43, 0.85) 50%)',
    ),
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

        .sidebar-row[data-selected] {
            background-color: ${viraThemeByKeys.blue['behind-bg'].decoration.background.value};
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

        .editor-host {
            flex-grow: 1;
            min-width: 0;
            min-height: 0;
            overflow: auto;
        }

        .editor-host[data-hidden] {
            display: none;
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
        }

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
        const displayedOldContent = (
            content: Readonly<{oldContent: string; newContent: string}>,
        ) =>
            state.hideWhitespace
                ? foldWhitespaceOnlyChanges({
                      oldContent: content.oldContent,
                      newContent: content.newContent,
                  })
                : content.oldContent;

        /**
         * Writes the config so the choice sticks across reloads, and updates the local copy without
         * waiting on the round trip so the toolbar responds immediately.
         */
        const saveDiffSettings = (
            nextSettings: Readonly<{diffLayout?: DiffLayout; hideWhitespace?: boolean}>,
        ) => {
            updateState(nextSettings);
            void getConfig()
                .then((config) =>
                    putConfig({
                        ...config,
                        diffLayout: nextSettings.diffLayout ?? state.diffLayout,
                        diffHideWhitespace: nextSettings.hideWhitespace ?? state.hideWhitespace,
                    }),
                )
                .catch((error: unknown) => {
                    updateState({
                        statusError: error instanceof Error ? error.message : String(error),
                    });
                });
        };

        /**
         * Re-read status and, if a file is open, its contents. Both writes go through the same
         * content comparison the editor rebuild uses, so a poll that finds nothing new is inert.
         */
        const refresh = async (): Promise<void> => {
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
            });

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
        };

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
                /** A different folder's file list and diff must not linger through the reload. */
                ...(state.armedFolder === undefined
                    ? {}
                    : {
                          status: undefined,
                          selectedValue: undefined,
                          diffContent: undefined,
                          allowLargeValues: [],
                      }),
            });
            void refresh();
        } else if (!inputs.active && state.armedFolder !== undefined) {
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
        const showLargeDiffAnyway = () => {
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
        };

        const selectFile = (value: string) => {
            updateState({
                selectedValue: value,
                diffContent: undefined,
                diffError: undefined,
                activeChunkIndex: 0,
            });
            void refresh();
        };

        /** Run an index write, then immediately re-read so the pane reflects it without waiting. */
        const runIndexWrite = async (write: () => Promise<void>): Promise<void> => {
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
        };

        const onStageWholeFile = ({path, side}: Readonly<{path: string; side: GitDiffSide}>) => {
            void runIndexWrite(async () => {
                await setGitFileStaged({
                    folder: inputs.folder,
                    path,
                    side,
                });
            });
        };

        const onStageWholeSide = (side: GitDiffSide) => {
            void runIndexWrite(async () => {
                await setGitSideStaged({
                    folder: inputs.folder,
                    side,
                });
            });
        };

        /** Confirmed for the same reason {@link onDiscardFile} is, and over more files. */
        const onDiscardAll = () => {
            if (
                !window.confirm(
                    [
                        'Discard every change in this repo?',
                        'This throws away both staged and unstaged changes to every changed file and cannot be undone.',
                    ].join('\n\n'),
                )
            ) {
                return;
            }
            void runIndexWrite(async () => {
                await discardAllGitChanges({
                    folder: inputs.folder,
                });
            });
        };

        /** Confirmed, because unlike everything else in this pane it can't be undone from git. */
        const onDiscardFile = (path: string) => {
            if (
                !window.confirm(
                    [
                        `Discard all changes to ${path}?`,
                        'This throws away both staged and unstaged changes and cannot be undone.',
                    ].join('\n\n'),
                )
            ) {
                return;
            }
            void runIndexWrite(async () => {
                await discardGitFile({
                    folder: inputs.folder,
                    path,
                });
            });
        };

        /**
         * The arguments both hunk endpoints take, or undefined when the pane no longer has the file
         * the chunk came from. Chunk offsets are character positions and the endpoints address
         * lines. Converting here (rather than server-side) keeps the server from having to re-run
         * the same diff. The old side has to be the same text the chunks were built from — folding
         * whitespace rewrites line contents, so character offsets only line up against the folded
         * copy.
         */
        const toHunkRequest = (chunk: Readonly<Chunk>) => {
            const target = findSelected(state.status, state.selectedValue);
            const content = state.diffContent;
            if (!target || !content) {
                return undefined;
            }
            const oldLines = toLineRange({
                text: Text.of(displayedOldContent(content).split('\n')),
                from: chunk.fromA,
                to: chunk.toA,
            });
            const newLines = toLineRange({
                text: Text.of(content.newContent.split('\n')),
                from: chunk.fromB,
                to: chunk.toB,
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
        };

        const onStageChunk = (chunk: Readonly<Chunk>) => {
            const request = toHunkRequest(chunk);
            if (!request) {
                return;
            }
            void runIndexWrite(async () => {
                await setGitHunkStaged(request);
                /** Landing back on the first chunk avoids pointing at a chunk that just moved. */
                updateState({
                    activeChunkIndex: 0,
                });
            });
        };

        /** Confirmed, because unlike staging this throws the change away for good. */
        const onUndoChunk = (chunk: Readonly<Chunk>) => {
            const request = toHunkRequest(chunk);
            if (
                !request ||
                !window.confirm(
                    [
                        `Undo this hunk in ${request.path}?`,
                        'This throws the change away and cannot be undone.',
                    ].join('\n\n'),
                )
            ) {
                return;
            }
            void runIndexWrite(async () => {
                await discardGitHunk(request);
                updateState({
                    activeChunkIndex: 0,
                });
            });
        };

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

        if (
            state.editorParent &&
            content &&
            !content.tooLargeOrBinary &&
            state.selectedValue &&
            state.syntaxPath === selectedPath
        ) {
            const nextRendered = {
                value: state.selectedValue,
                oldContent: displayedOldContent(content),
                newContent: content.newContent,
                unified,
                isDark: state.isDark,
            };
            const previous = state.rendered;
            const changed =
                !previous ||
                previous.value !== nextRendered.value ||
                previous.oldContent !== nextRendered.oldContent ||
                previous.newContent !== nextRendered.newContent ||
                previous.unified !== nextRendered.unified ||
                previous.isDark !== nextRendered.isDark;
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
                    newText,
                    stageLabel: stageLabels[selected?.side ?? GitDiffSide.Unstaged],
                    syntaxExtensions: state.syntaxExtensions,
                    isDark: state.isDark,
                    onStageChunk,
                    onUndoChunk: selected?.side === GitDiffSide.Staged ? undefined : onUndoChunk,
                    onGeometryChange: (view) => {
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
            }
        }

        /** Scroll the editor so the given chunk sits at the top of the viewport. */
        const scrollToChunk = (index: number) => {
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
        };

        const stepChunk = (delta: number) => {
            if (!state.chunks.length) {
                return;
            }
            const next = Math.min(
                state.chunks.length - 1,
                Math.max(0, state.activeChunkIndex + delta),
            );
            scrollToChunk(next);
        };

        const stepFile = (delta: number) => {
            const values = allSelectValues(state.status);
            const current = state.selectedValue ? values.indexOf(state.selectedValue) : -1;
            const next = values[Math.min(values.length - 1, Math.max(0, current + delta))];
            if (next && next !== state.selectedValue) {
                selectFile(next);
            }
        };

        const hasFiles = allSelectValues(state.status).length > 0;
        /** Touch targets need the room; a mouse pointer does not. */
        const buttonSize = isMobile ? ViraSize.Large : ViraSize.Small;

        host.style.setProperty('--sidebar-width', `${state.sidebarWidth}px`);

        /**
         * Sidebar resize, the same pointer-capture drag the CLI panes use. Width is measured from
         * the host's right edge, since the sidebar is what's being sized and it's anchored there.
         */
        const onDividerPointerDown = (event: PointerEvent) => {
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

            const onMove = (moveEvent: PointerEvent) => {
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
            };

            const onUp = (upEvent: PointerEvent) => {
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
            };

            window.addEventListener('pointermove', onMove);
            window.addEventListener('pointerup', onUp);
            window.addEventListener('pointercancel', onUp);
        };

        /**
         * One collapsible sidebar section. Each side gets its own fixed slot in the parent template
         * even when it's empty, so a file moving across the index can't make lit reuse the staged
         * section's element as the unstaged one and carry its collapsed state along with it.
         */
        /**
         * Bulk buttons in each section's header. `stopPropagation` keeps the click from reaching
         * the collapsible's header, which would otherwise fold the section the button just emptied.
         * The staged side gets no discard-all: discarding is not per-side (it always throws away
         * both halves), so one copy of it, on the side that also holds untracked files, is enough.
         */
        const sideHeaderActions: Readonly<Record<GitDiffSide, () => HtmlInterpolation>> = {
            [GitDiffSide.Unstaged]: () => html`
                <button
                    type="button"
                    class="row-action"
                    title="Discard all changes in this repo"
                    ?disabled=${state.busy}
                    ${listen('click', (event) => {
                        event.stopPropagation();
                        onDiscardAll();
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
            `,
            [GitDiffSide.Staged]: () => html`
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
            `,
        };

        const renderSidebarSection = (side: GitDiffSide) => {
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
                        <div class="header-actions">${sideHeaderActions[side]()}</div>
                    </div>
                    ${files.map((file) => {
                        const value = toSelectValue(side, file.path);
                        return html`
                            <div
                                class="sidebar-row"
                                ?data-selected=${value === state.selectedValue}
                            >
                                <button
                                    type="button"
                                    class="sidebar-row-open"
                                    title=${file.path}
                                    ${listen('click', () => selectFile(value))}
                                >
                                    ${fileRowContents(file)}
                                </button>
                                <div class="row-actions">
                                    <button
                                        type="button"
                                        class="row-action"
                                        title="Discard all changes to this file"
                                        ?data-hidden=${side === GitDiffSide.Staged}
                                        ?disabled=${state.busy || side === GitDiffSide.Staged}
                                        ${listen('click', () => onDiscardFile(file.path))}
                                    >
                                        <${ViraIcon.assign({
                                            icon: revertIcon,
                                        })}></${ViraIcon}>
                                    </button>
                                    <button
                                        type="button"
                                        class="row-action"
                                        title=${stageActionLabels[side]}
                                        ?disabled=${state.busy}
                                        ${listen('click', () =>
                                            onStageWholeFile({
                                                path: file.path,
                                                side,
                                            }),
                                        )}
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
        };

        return html`
            <div class="toolbar" ?data-mobile=${isMobile}>
                ${isMobile
                    ? html`
                          <${ViraMenuTrigger.assign({
                              horizontalAnchor: HorizontalAnchor.Left,
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
                              ${toMenuGroups(state.status).map(
                                  (group) => html`
                                      <div class="menu-group-header">
                                          ${sideLabels[group.side]} (${group.files.length})
                                      </div>
                                      ${group.files.map((file) => {
                                          const value = toSelectValue(group.side, file.path);
                                          return html`
                                              <${ViraMenuItem.assign({
                                                  selected: value === state.selectedValue,
                                              })}
                                                  ${listen(ViraMenuItem.events.activate, () =>
                                                      selectFile(value),
                                                  )}
                                              >
                                                  <div class="menu-row" title=${file.path}>
                                                      ${fileRowContents(file)}
                                                  </div>
                                              </${ViraMenuItem}>
                                          `;
                                      })}
                                  `,
                              )}
                          </${ViraMenuTrigger}>
                      `
                    : ''}
                <div class="toolbar-actions">
                    <div class="toolbar-group">
                        <${ViraButton.assign({
                            icon: lucideIcons.ChevronLeft,
                            buttonSize,
                            buttonEmphasis: ViraEmphasis.Subtle,
                            color: ViraColorVariant.Plain,
                            isDisabled: !hasFiles,
                        })}
                            title="Previous file"
                            ${listen('click', () => stepFile(-1))}
                        ></${ViraButton}>
                        <${ViraButton.assign({
                            icon: lucideIcons.ChevronRight,
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
                            icon: lucideIcons.ChevronUp,
                            buttonSize,
                            buttonEmphasis: ViraEmphasis.Subtle,
                            color: ViraColorVariant.Plain,
                            isDisabled: !state.chunks.length,
                        })}
                            title="Previous change"
                            ${listen('click', () => stepChunk(-1))}
                        ></${ViraButton}>
                        <${ViraButton.assign({
                            icon: lucideIcons.ChevronDown,
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
                        ${listen('click', () =>
                            saveDiffSettings({
                                diffLayout: unified ? DiffLayout.Split : DiffLayout.Inline,
                            }),
                        )}
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
                        ${listen('click', () =>
                            saveDiffSettings({
                                hideWhitespace: !state.hideWhitespace,
                            }),
                        )}
                    ></${ViraButton}>
                    <${ViraButton.assign({
                        text: selected ? stageActionLabels[selected.side] : 'Stage',
                        buttonSize,
                        color: ViraColorVariant.Neutral,
                        isDisabled: !selected || state.busy,
                    })}
                        title="Move the whole file across the index"
                        ${listen('click', () => {
                            if (selected) {
                                onStageWholeFile({
                                    path: selected.file.path,
                                    side: selected.side,
                                });
                            }
                        })}
                    ></${ViraButton}>
                </div>
            </div>
            ${selected
                ? html`
                      <div class="selected-path" title=${selected.file.path}>
                          ${selected.file.path}
                      </div>
                  `
                : ''}
            <div class="body">
                ${state.statusError || state.diffError
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
                              : ''
                          : html`
                                <div class="placeholder">Select a file to see its diff.</div>
                            `
                      : html`
                            <div class="placeholder">No changes in this folder.</div>
                        `}
                <div
                    class="editor-host"
                    ?data-hidden=${!selected || content?.tooLargeOrBinary}
                    ${onDomCreated((element) => {
                        if (element instanceof HTMLElement && !state.editorParent) {
                            updateState({
                                editorParent: element,
                            });
                        }
                    })}
                ></div>
                ${selected && !content && !state.diffError
                    ? html`
                          <div class="loading-overlay">
                              <${ViraIcon.assign({
                                  icon: LoaderAnimated24Icon,
                              })}></${ViraIcon}>
                          </div>
                      `
                    : ''}
                ${state.rulerMarks.length && content && !content.tooLargeOrBinary
                    ? html`
                          <div class="ruler">
                              ${state.rulerMarks.map(
                                  (mark, index) => html`
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
                                  `,
                              )}
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
