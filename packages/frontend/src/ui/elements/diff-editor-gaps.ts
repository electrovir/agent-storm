import {check} from '@augment-vir/assert';
import {createArray} from '@augment-vir/common';
import {getChunks, mergeViewSiblings} from '@codemirror/merge';
import {StateEffect, StateField, type EditorState} from '@codemirror/state';
import {Decoration, EditorView, WidgetType, type DecorationSet} from '@codemirror/view';
import {
    LucideChevronDownIcon,
    LucideChevronUpIcon,
    LucideUnfoldVerticalIcon,
    ViraColorVariant,
    createSizedIcon,
    type ViraIconSvg,
} from 'vira';
import {editorSurfaceColors} from './diff-editor-colors.js';
import {buildWidgetButton} from './diff-editor-widgets.js';

/** Hidden lines one expand click reveals, the same step GitHub uses. */
const expandStep = 20;

/** Unchanged lines left showing beside each change. */
const collapseMargin = 3;

/** A shorter unchanged run stays visible, since its bar would hide barely more than it covers. */
const collapseMinLines = 4;

const expandDownIcon = createSizedIcon(LucideChevronDownIcon, 12);
const expandUpIcon = createSizedIcon(LucideChevronUpIcon, 12);
const expandAllIcon = createSizedIcon(LucideUnfoldVerticalIcon, 12);

/**
 * Lines revealed so far at each end of one unchanged run between changes. Runs are keyed by their
 * index, where run 0 comes before the first change, which both sides of a side-by-side diff share.
 */
type GapExpansion = {
    /** Revealed at the run's top, just below the change before it. */
    below: number;
    /** Revealed at the run's bottom, just above the change after it. */
    above: number;
};

type GapExpandRequest = {
    gapIndex: number;
    edge: keyof GapExpansion;
    lineCount: number;
};

const expandGapEffect = StateEffect.define<GapExpandRequest>();

/**
 * Hides each long unchanged run behind a bar with GitHub-style expand buttons, replacing
 * CodeMirror's own `collapseUnchanged`, whose bar can only reveal a whole run at once.
 */
const collapsedGapsField = StateField.define<{
    expansions: Readonly<Record<number, Readonly<GapExpansion>>>;
    decorations: DecorationSet;
}>({
    create(state) {
        return {
            expansions: {},
            decorations: buildCollapsedGaps(state, {}),
        };
    },
    update(collapsed, transaction) {
        const requests = transaction.effects.filter((effect) => effect.is(expandGapEffect));
        /**
         * `MergeView` adds its chunks in a configuration step after the editor state is created, so
         * the first build here finds none.
         */
        const chunksChanged =
            getChunks(transaction.state)?.chunks !== getChunks(transaction.startState)?.chunks;
        if (!requests.length && !chunksChanged) {
            return collapsed;
        }
        const expansions = requests.reduce<Readonly<Record<number, Readonly<GapExpansion>>>>(
            (latest, {value}) => {
                const current = latest[value.gapIndex] ?? {
                    below: 0,
                    above: 0,
                };
                return {
                    ...latest,
                    [value.gapIndex]: {
                        ...current,
                        [value.edge]: current[value.edge] + value.lineCount,
                    },
                };
            },
            collapsed.expansions,
        );
        return {
            expansions,
            decorations: buildCollapsedGaps(transaction.state, expansions),
        };
    },
    provide(field) {
        return EditorView.decorations.from(field, (collapsed) => collapsed.decorations);
    },
});

function buildCollapsedGaps(
    state: EditorState,
    expansions: Readonly<Record<number, Readonly<GapExpansion>>>,
) {
    const merge = getChunks(state);
    if (!merge) {
        return Decoration.none;
    }
    const isOldSide = merge.side === 'a';
    const doc = state.doc;
    /** Line math matches CodeMirror's own `collapseUnchanged`, so the runs land where its did. */
    const ranges = createArray(merge.chunks.length + 1, (gapIndex) => {
        const previous = merge.chunks[gapIndex - 1];
        const next = merge.chunks[gapIndex];
        const firstLine = previous
            ? doc.lineAt(Math.min(doc.length, isOldSide ? previous.toA : previous.toB)).number +
              collapseMargin
            : 1;
        const lastLine = next
            ? doc.lineAt(isOldSide ? next.fromA : next.fromB).number - 1 - collapseMargin
            : doc.lines;
        if (lastLine - firstLine + 1 < collapseMinLines) {
            return undefined;
        }
        const from = firstLine + (expansions[gapIndex]?.below ?? 0);
        const to = lastLine - (expansions[gapIndex]?.above ?? 0);
        if (to < from) {
            return undefined;
        }
        return Decoration.replace({
            widget: new CollapsedGapWidget({
                gapIndex,
                hiddenLines: to - from + 1,
                hasPrevious: !!previous,
                hasNext: !!next,
            }),
            block: true,
        }).range(doc.line(from).from, doc.line(to).to);
    });
    return Decoration.set(ranges.filter(check.isTruthy));
}

/** A side-by-side diff expands the same run on both sides, so its rows stay aligned. */
function expandGap(view: EditorView, request: Readonly<GapExpandRequest>) {
    const siblings = mergeViewSiblings(view);
    (siblings
        ? [
              siblings.a,
              siblings.b,
          ]
        : [
              view,
          ]
    ).forEach((editor) => {
        editor.dispatch({
            effects: expandGapEffect.of(request),
        });
    });
}

class CollapsedGapWidget extends WidgetType {
    constructor(
        protected readonly gap: Readonly<{
            gapIndex: number;
            hiddenLines: number;
            hasPrevious: boolean;
            hasNext: boolean;
        }>,
    ) {
        super();
    }

    public override eq(other: CollapsedGapWidget): boolean {
        return (
            other.gap.gapIndex === this.gap.gapIndex &&
            other.gap.hiddenLines === this.gap.hiddenLines &&
            other.gap.hasPrevious === this.gap.hasPrevious &&
            other.gap.hasNext === this.gap.hasNext
        );
    }

    public override toDOM(view: EditorView): HTMLElement {
        const hiddenLines = this.gap.hiddenLines;
        const buttons: ReadonlyArray<
            | false
            | {
                  icon: ViraIconSvg;
                  label: string;
                  edge: keyof GapExpansion;
                  lineCount: number;
              }
        > =
            hiddenLines <= expandStep
                ? [
                      {
                          icon: expandAllIcon,
                          label: `Show ${hiddenLines} hidden lines`,
                          edge: this.gap.hasNext ? 'above' : 'below',
                          lineCount: hiddenLines,
                      },
                  ]
                : [
                      this.gap.hasPrevious && {
                          icon: expandDownIcon,
                          label: `Show ${expandStep} more lines below`,
                          edge: 'below',
                          lineCount: expandStep,
                      },
                      this.gap.hasNext && {
                          icon: expandUpIcon,
                          label: `Show ${expandStep} more lines above`,
                          edge: 'above',
                          lineCount: expandStep,
                      },
                  ];
        const wrapper = document.createElement('div');
        wrapper.className = 'agent-storm-collapsed-lines';
        const label = document.createElement('span');
        label.textContent = `${hiddenLines} unchanged lines`;
        wrapper.append(
            ...buttons.filter(check.isTruthy).map((button) => {
                return buildWidgetButton({
                    label: button.label,
                    icon: button.icon,
                    color: ViraColorVariant.Plain,
                    onClick: () => {
                        expandGap(view, {
                            gapIndex: this.gap.gapIndex,
                            edge: button.edge,
                            lineCount: button.lineCount,
                        });
                    },
                });
            }),
            label,
        );
        return wrapper;
    }
}

export function collapsedGapsExtension(isDark: boolean) {
    return [
        collapsedGapsField,
        EditorView.theme({
            '.agent-storm-collapsed-lines': {
                display: 'flex',
                alignItems: 'center',
                gap: '2px',
                padding: '0 8px',
                background: isDark ? 'rgba(255, 255, 255, 0.06)' : 'rgba(0, 0, 0, 0.04)',
                color: editorSurfaceColors(isDark).lineNumber,
                fontFamily: 'system-ui, sans-serif',
            },
        }),
    ];
}
