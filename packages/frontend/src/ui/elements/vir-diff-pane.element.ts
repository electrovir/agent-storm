// cspell:words keymap, Meslo, Menlo, unstaging

import {
    GitDiffSide,
    GitFileChange,
    type GitDiffFile,
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
} from 'element-vir';
import {
    HorizontalAnchor,
    ViraButton,
    ViraCollapsibleCard,
    ViraColorVariant,
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
    discardGitFile,
    getGitDiffFile,
    getGitDiffStatus,
    setGitFileStaged,
    setGitHunkStaged,
} from '../../util/api-client.js';
import {loadSyntaxExtensions} from '../../util/diff-syntax.js';
import {diffSidebarWidth, localStorageClient} from '../../util/local-storage-client.js';
import {ScreenSize} from '../../util/screen-size.js';

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

/** Direction the row's stage button moves the file, matching {@link stageActionLabels}. */
const stageActionIcons: Readonly<Record<GitDiffSide, ViraIconSvg>> = {
    [GitDiffSide.Staged]: createSizedIcon(lucideIcons.Minus, 14),
    [GitDiffSide.Unstaged]: createSizedIcon(lucideIcons.Plus, 14),
};

/**
 * A path's final segment, and everything before it. Split apart so the file rows can dim the
 * directory and keep the name that actually identifies the file at full contrast.
 */
function basename(path: string): string {
    const parts = extractExtension(path);
    return `${parts.basename}${parts.extension}`;
}

function dirnamePrefix(path: string): string {
    return extractExtension(path).dirname;
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

/** One file's row contents, shared by the desktop sidebar and the mobile dropdown. */
function fileRowContents(file: Readonly<GitDiffFile>) {
    return html`
        <span
            class="badge"
            style=${css`
                color: ${changeBadgeColors[file.change]};
            `}
        >
            ${changeBadges[file.change]}
        </span>
        <span class="file-path">
            <span class="file-dirname">${dirnamePrefix(file.path)}</span>
            <span class="file-basename">${basename(file.path)}</span>
        </span>
        <span class="counts">
            <span class="insertions">+${file.insertions}</span>
            <span class="deletions">−${file.deletions}</span>
        </span>
    `;
}

/**
 * Shared read-only editor extensions. Deliberately minimal: the point of replacing the embedded VS
 * Code is that a phone shouldn't pay for an IDE to read a diff.
 */
const baseExtensions: ReadonlyArray<Extension> = [
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
    EditorView.theme({
        '&': {
            height: '100%',
            fontSize: '12px',
        },
        '.cm-scroller': {
            fontFamily: '"MesloLGS NF", Menlo, monospace',
        },
    }),
];

/**
 * CodeMirror's stock merge colors are a few percent of tint and wash out entirely on a bright
 * screen. These are strong enough to find by scanning. The `.cm-changedText` variants are the
 * within-line spans, which sit on top of the line tint and so have to be darker again to read as a
 * separate layer.
 */
const deletionColorTheme = EditorView.theme({
    '.cm-changedLine': {
        backgroundColor: 'rgba(248, 81, 73, 0.24)',
    },
    '.cm-changedText': {
        backgroundColor: 'rgba(248, 81, 73, 0.48)',
    },
    '.cm-changedLineGutter': {
        backgroundColor: 'rgba(248, 81, 73, 0.30)',
    },
});

const insertionColorTheme = EditorView.theme({
    '.cm-changedLine': {
        backgroundColor: 'rgba(46, 160, 67, 0.24)',
    },
    '.cm-changedText': {
        backgroundColor: 'rgba(46, 160, 67, 0.48)',
    },
    '.cm-changedLineGutter': {
        backgroundColor: 'rgba(46, 160, 67, 0.30)',
    },
});

/** The unified view stacks both sides in one editor, so it needs both color families at once. */
const unifiedColorTheme = EditorView.theme({
    '.cm-deletedChunk': {
        backgroundColor: 'rgba(248, 81, 73, 0.18)',
    },
    '.cm-deletedLine, .cm-deletedChunk .cm-deletedLine': {
        backgroundColor: 'rgba(248, 81, 73, 0.24)',
    },
    '.cm-deletedText': {
        backgroundColor: 'rgba(248, 81, 73, 0.48)',
    },
    '.cm-insertedLine, .cm-changedLine': {
        backgroundColor: 'rgba(46, 160, 67, 0.24)',
    },
    '.cm-changedText': {
        backgroundColor: 'rgba(46, 160, 67, 0.48)',
    },
    '.cm-changedLineGutter': {
        backgroundColor: 'rgba(46, 160, 67, 0.30)',
    },
});

/** A button rendered above a chunk that moves just that chunk across the index. */
class HunkStageWidget extends WidgetType {
    constructor(
        protected readonly label: string,
        protected readonly onStage: () => void,
    ) {
        super();
    }

    public override eq(other: HunkStageWidget): boolean {
        return other.label === this.label;
    }

    public override toDOM(): HTMLElement {
        const wrapper = document.createElement('div');
        wrapper.className = 'agent-storm-hunk-actions';
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = this.label;
        button.addEventListener('click', (event) => {
            event.preventDefault();
            this.onStage();
        });
        wrapper.append(button);
        return wrapper;
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
    onStageChunk,
}: Readonly<{
    chunks: ReadonlyArray<Chunk>;
    newText: Text;
    label: string;
    onStageChunk: (chunk: Readonly<Chunk>) => void;
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
                widget: new HunkStageWidget(label, () => onStageChunk(chunk)),
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
                padding: '1px 6px',
            },
            '.agent-storm-hunk-actions button': {
                font: 'inherit',
                fontSize: '10px',
                lineHeight: '1',
                padding: '2px 8px',
                cursor: 'pointer',
                borderRadius: '3px',
                border: '1px solid rgba(0, 0, 0, 0.2)',
                background: 'rgba(255, 255, 255, 0.85)',
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
    onStageChunk,
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
    onStageChunk: (chunk: Readonly<Chunk>) => void;
}>): MountedEditor {
    const hunkButtons = hunkButtonExtension({
        chunks,
        newText,
        label: stageLabel,
        onStageChunk,
    });

    if (unified) {
        const view = new EditorView({
            parent,
            root,
            doc: newContent,
            extensions: [
                ...baseExtensions,
                ...syntaxExtensions,
                unifiedColorTheme,
                hunkButtons,
                unifiedMergeView({
                    original: oldContent,
                    /** Read-only pane: there is nothing to revert a chunk into. */
                    mergeControls: false,
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
                ...baseExtensions,
                ...syntaxExtensions,
                deletionColorTheme,
            ],
        },
        b: {
            doc: newContent,
            extensions: [
                ...baseExtensions,
                ...syntaxExtensions,
                insertionColorTheme,
                hunkButtons,
            ],
        },
        gutter: true,
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

const rulerColors = {
    inserted: unsafeCSS('rgba(46, 160, 67, 0.85)'),
    deleted: unsafeCSS('rgba(248, 81, 73, 0.85)'),
    modified: unsafeCSS('rgba(56, 139, 253, 0.85)'),
};

/** Smallest visible ruler mark, so a one-line change in a huge file is still clickable. */
const minRulerMarkPercent = 0.8;

function toRulerMarks(chunks: ReadonlyArray<Chunk>, newText: Text): RulerMark[] {
    const totalLines = Math.max(1, newText.lines);
    return chunks.map((chunk) => {
        const lines = toLineRange({
            text: newText,
            from: chunk.fromB,
            to: chunk.toB,
        });
        return {
            topPercent: (lines.from / totalLines) * 100,
            heightPercent: Math.max(
                minRulerMarkPercent,
                (Math.max(1, lines.to - lines.from) / totalLines) * 100,
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
    state() {
        return {
            status: undefined as GitDiffStatus | undefined,
            statusError: undefined as string | undefined,
            selectedValue: undefined as string | undefined,
            /** Old/new text for the selected file, or undefined while it loads. */
            diffContent: undefined as
                | {oldContent: string; newContent: string; tooLargeOrBinary: boolean}
                | undefined,
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
                | {value: string; oldContent: string; newContent: string; unified: boolean}
                | undefined,
            chunks: [] as ReadonlyArray<Chunk>,
            rulerMarks: [] as RulerMark[],
            /** Index into `chunks` that the jump buttons move relative to. */
            activeChunkIndex: 0,
            /** User's layout choice. Undefined follows the screen size. */
            unifiedOverride: undefined as boolean | undefined,
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
            align-items: baseline;
            gap: 10px;
            min-width: 0;
            max-width: 60vw;
        }

        .file-path {
            flex-grow: 1;
            min-width: 0;
            overflow: hidden;
            white-space: nowrap;
            text-overflow: ellipsis;
        }

        .file-dirname {
            color: ${viraThemeByKeys.grey.foreground['non-body'].foreground.value};
        }

        .file-basename {
            font-weight: 600;
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
            flex-grow: 1;
            padding: 6px 8px 2px;
            font-size: 10px;
            letter-spacing: 0.06em;
            text-transform: uppercase;
            color: ${viraThemeByKeys.grey.foreground['non-body'].foreground.value};
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
            align-items: baseline;
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

        .counts {
            flex-grow: 0;
            flex-shrink: 0;
            display: flex;
            gap: 4px;
            font-size: 11px;
            font-family: 'MesloLGS NF', Menlo, monospace;
        }

        .insertions {
            color: ${viraThemeByKeys.green.foreground.body.foreground.value};
        }

        .deletions {
            color: ${viraThemeByKeys.red.foreground.body.foreground.value};
        }

        .body {
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
            align-items: center;
            justify-content: center;
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
        if (state.refreshTimer) {
            clearInterval(state.refreshTimer);
        }
    },
    render({inputs, state, updateState, host}) {
        const isMobile = inputs.screenSize === ScreenSize.Mobile;
        const unified = state.unifiedOverride ?? isMobile;
        const selected = findSelected(state.status, state.selectedValue);

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
            /**
             * Keep the current selection when it still exists, otherwise fall back to the first
             * file so the pane is never showing a stale diff for a file that's gone.
             */
            const values = allSelectValues(status);
            const selectedValue =
                state.selectedValue && values.includes(state.selectedValue)
                    ? state.selectedValue
                    : values[0];
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

        const onStageChunk = (chunk: Readonly<Chunk>) => {
            const target = findSelected(state.status, state.selectedValue);
            const content = state.diffContent;
            if (!target || !content) {
                return;
            }
            /**
             * Chunk offsets are character positions; the endpoint addresses lines. Converting here
             * (rather than server-side) keeps the server from having to re-run the same diff.
             */
            const oldLines = toLineRange({
                text: Text.of(content.oldContent.split('\n')),
                from: chunk.fromA,
                to: chunk.toA,
            });
            const newLines = toLineRange({
                text: Text.of(content.newContent.split('\n')),
                from: chunk.fromB,
                to: chunk.toB,
            });
            void runIndexWrite(async () => {
                await setGitHunkStaged({
                    folder: inputs.folder,
                    path: target.file.path,
                    oldPath: target.file.oldPath ?? undefined,
                    side: target.side,
                    fromOldLine: oldLines.from,
                    toOldLine: oldLines.to,
                    fromNewLine: newLines.from,
                    toNewLine: newLines.to,
                });
                /** Landing back on the first chunk avoids pointing at a chunk that just moved. */
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
                oldContent: content.oldContent,
                newContent: content.newContent,
                unified,
            };
            const previous = state.rendered;
            const changed =
                !previous ||
                previous.value !== nextRendered.value ||
                previous.oldContent !== nextRendered.oldContent ||
                previous.newContent !== nextRendered.newContent ||
                previous.unified !== nextRendered.unified;
            if (changed) {
                const oldText = Text.of(content.oldContent.split('\n'));
                const newText = Text.of(content.newContent.split('\n'));
                const chunks = Chunk.build(oldText, newText);
                state.editor?.destroy();
                state.editorParent.replaceChildren();
                updateState({
                    rendered: nextRendered,
                    chunks,
                    rulerMarks: toRulerMarks(chunks, newText),
                    editor: mountDiffEditor({
                        parent: state.editorParent,
                        root: host.shadowRoot,
                        oldContent: content.oldContent,
                        newContent: content.newContent,
                        unified,
                        chunks,
                        newText,
                        stageLabel: stageLabels[selected?.side ?? GitDiffSide.Unstaged],
                        syntaxExtensions: state.syntaxExtensions,
                        onStageChunk,
                    }),
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
                        ${sideLabels[side]} (${files.length})
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
                                            <span class="trigger-name">
                                                ${basename(selected.file.path)}
                                            </span>
                                            <span class="counts">
                                                <span class="insertions">
                                                    +${selected.file.insertions}
                                                </span>
                                                <span class="deletions">
                                                    −${selected.file.deletions}
                                                </span>
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
                            color: ViraColorVariant.Plain,
                            isDisabled: !hasFiles,
                        })}
                            title="Previous file"
                            ${listen('click', () => stepFile(-1))}
                        ></${ViraButton}>
                        <${ViraButton.assign({
                            icon: lucideIcons.ChevronRight,
                            buttonSize,
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
                            color: ViraColorVariant.Plain,
                            isDisabled: !state.chunks.length,
                        })}
                            title="Previous change"
                            ${listen('click', () => stepChunk(-1))}
                        ></${ViraButton}>
                        <${ViraButton.assign({
                            icon: lucideIcons.ChevronDown,
                            buttonSize,
                            color: ViraColorVariant.Plain,
                            isDisabled: !state.chunks.length,
                        })}
                            title="Next change"
                            ${listen('click', () => stepChunk(1))}
                        ></${ViraButton}>
                    </div>
                    <${ViraButton.assign({
                        icon: unified ? lucideIcons.Columns2 : lucideIcons.Rows2,
                        buttonSize,
                        color: ViraColorVariant.Plain,
                    })}
                        title=${unified ? 'Switch to side-by-side' : 'Switch to inline'}
                        ${listen('click', () =>
                            updateState({
                                unifiedOverride: !unified,
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
                                        Binary or oversized file — no diff shown.
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
                    ?data-hidden=${!content || content.tooLargeOrBinary}
                    ${onDomCreated((element) => {
                        if (element instanceof HTMLElement && !state.editorParent) {
                            updateState({
                                editorParent: element,
                            });
                        }
                    })}
                ></div>
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
                                              background-color: ${mark.color};
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
