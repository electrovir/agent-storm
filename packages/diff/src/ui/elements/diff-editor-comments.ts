// cspell:words prec

import {type ReviewComment} from '@agent-storm/common';
import {Prec, StateEffect, StateField} from '@codemirror/state';
import {
    Decoration,
    EditorView,
    GutterMarker,
    ViewPlugin,
    WidgetType,
    gutter,
} from '@codemirror/view';
import {
    LucideMessageSquarePlusIcon,
    LucidePencilIcon,
    LucideTrashIcon,
    ViraColorVariant,
    ViraIcon,
    createSizedIcon,
    viraThemeByKeys,
} from 'vira';
import {buildWidgetButton, keepSelectionOnPress} from './diff-editor-widgets.js';

/** Sized to fit the diff's own gutter beside a single line. */
const addCommentIcon = createSizedIcon(LucideMessageSquarePlusIcon, 11);
const deleteCommentIcon = createSizedIcon(LucideTrashIcon, 12);
const editCommentIcon = createSizedIcon(LucidePencilIcon, 12);

/** Where a comment's edit button asks for the composer to reopen, prefilled with that comment. */
export type EditCommentRequest = Omit<AddCommentRequest, 'lineNumber'> & {
    comment: ReviewComment;
};

/** Where a line's add-comment button asks for the comment composer to open. */
export type AddCommentRequest = {
    /** 1-based line in the new side's document. */
    lineNumber: number;
    /** The clicked button's viewport rectangle, for placing the composer beside it. */
    anchor: DOMRect;
    /**
     * Viewport y of the line's bottom edge, wrapped rows included, for placing the composer under
     * it.
     */
    lineBottom: number;
};

/** What the diff's comment buttons call. The editor holds no comments of its own. */
export type DiffCommentHandlers = Readonly<{
    onAddComment: (request: AddCommentRequest) => void;
    onEditComment: (request: Readonly<EditCommentRequest>) => void;
    onDeleteComment: (comment: Readonly<ReviewComment>) => void;
}>;

/** 1-based line the open comment composer is writing about, undefined while it is closed. */
export const setCommentingLineEffect = StateEffect.define<number | undefined>();

export const commentingLineField = StateField.define<number | undefined>({
    create() {
        return undefined;
    },
    update(commentingLine, transaction) {
        return transaction.effects.reduce(
            (latest, effect) => (effect.is(setCommentingLineEffect) ? effect.value : latest),
            commentingLine,
        );
    },
    provide(field) {
        return EditorView.decorations.compute([field], (state) => {
            const line = state.field(field);
            return line == undefined || line < 1 || line > state.doc.lines
                ? Decoration.none
                : Decoration.set([
                      Decoration.line({
                          class: 'agent-storm-commenting-line',
                      }).range(state.doc.line(line).from),
                  ]);
        });
    },
});

const addCommentButtonClass = 'agent-storm-add-comment';

/** Marks the add-comment button of the line under the pointer, the only one shown on desktop. */
const hoveredMarkerAttribute = 'data-hovered';

/**
 * Hovering a single line can't be expressed in CSS: the gutter element and the line it sits beside
 * are in different containers, so the pointer's line is tracked here instead.
 *
 * This flags the line's button in the DOM rather than dispatching a transaction: in Safari, an
 * editor update clears a word selected by double click.
 */
const hoveredLineTracker = ViewPlugin.define((view) => {
    const hovered = {
        marker: undefined as Element | undefined,
    };
    function setHoveredLine(lineStart: number | undefined) {
        const marker =
            lineStart == undefined
                ? undefined
                : view.dom.querySelector(
                      `.agent-storm-comment-gutter [data-line-start="${lineStart}"]`,
                  ) || undefined;
        if (marker === hovered.marker) {
            return;
        }
        hovered.marker?.removeAttribute(hoveredMarkerAttribute);
        marker?.setAttribute(hoveredMarkerAttribute, '');
        hovered.marker = marker;
    }
    function onMouseMove(event: MouseEvent) {
        const position = view.posAtCoords(
            {
                x: event.clientX,
                y: event.clientY,
            },
            false,
        );
        setHoveredLine(view.state.doc.lineAt(position).from);
    }
    function onMouseLeave() {
        setHoveredLine(undefined);
    }
    view.scrollDOM.addEventListener('mousemove', onMouseMove);
    view.scrollDOM.addEventListener('mouseleave', onMouseLeave);
    return {
        destroy() {
            view.scrollDOM.removeEventListener('mousemove', onMouseMove);
            view.scrollDOM.removeEventListener('mouseleave', onMouseLeave);
        },
    };
});

class AddCommentMarker extends GutterMarker {
    constructor(
        protected readonly lineStart: number,
        protected readonly isMobile: boolean,
        protected readonly onAddComment: (request: AddCommentRequest) => void,
    ) {
        super();
    }

    /** Includes the line, since a reused DOM node would keep the click handler of its old line. */
    public override eq(other: AddCommentMarker): boolean {
        return other.lineStart === this.lineStart && other.isMobile === this.isMobile;
    }

    /** A native button rather than a `ViraButton`, which can't shrink to fit the gutter. */
    public override toDOM(view: EditorView): HTMLElement {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = addCommentButtonClass;
        button.title = 'Add review comment';
        button.setAttribute('aria-label', button.title);
        button.setAttribute('data-line-start', String(this.lineStart));
        const icon = new ViraIcon();
        icon.assignInputs({
            icon: this.isMobile ? LucideMessageSquarePlusIcon : addCommentIcon,
        });
        button.append(icon);
        keepSelectionOnPress(button);
        button.addEventListener('click', (event) => {
            event.preventDefault();
            this.onAddComment({
                lineNumber: view.state.doc.lineAt(this.lineStart).number,
                anchor: button.getBoundingClientRect(),
                lineBottom: view.lineBlockAt(this.lineStart).bottom + view.documentTop,
            });
        });
        return button;
    }
}

/** Replaces every comment shown in the editor with this list. */
export const setReviewCommentsEffect = StateEffect.define<ReadonlyArray<ReviewComment>>();

class ReviewCommentWidget extends WidgetType {
    constructor(
        protected readonly comment: Readonly<ReviewComment>,
        protected readonly onEditComment: (request: Readonly<EditCommentRequest>) => void,
        protected readonly onDeleteComment: (comment: Readonly<ReviewComment>) => void,
    ) {
        super();
    }

    public override eq(other: ReviewCommentWidget): boolean {
        return other.comment.id === this.comment.id && other.comment.body === this.comment.body;
    }

    public override toDOM(): HTMLElement {
        const wrapper = document.createElement('div');
        wrapper.className = 'agent-storm-review-comment';
        const body = document.createElement('div');
        body.className = 'agent-storm-review-comment-body';
        body.textContent = this.comment.body;
        wrapper.append(
            body,
            buildWidgetButton({
                label: 'Edit review comment',
                icon: editCommentIcon,
                color: ViraColorVariant.Neutral,
                onClick: (button) => {
                    this.onEditComment({
                        comment: this.comment,
                        anchor: button.getBoundingClientRect(),
                        lineBottom: wrapper.getBoundingClientRect().bottom,
                    });
                },
            }),
            buildWidgetButton({
                label: 'Delete review comment',
                icon: deleteCommentIcon,
                color: ViraColorVariant.Danger,
                onClick: () => {
                    this.onDeleteComment(this.comment);
                },
            }),
        );
        return wrapper;
    }
}

/**
 * The review comment button beside the hovered line (the cursor line on touch, which has no hover),
 * and the stored review comments drawn under the lines they belong to. The comments arrive through
 * {@link setReviewCommentsEffect} rather than at mount, since they change without the diff
 * changing.
 */
export function reviewCommentExtension({
    isDark,
    isMobile,
    onAddComment,
    onEditComment,
    onDeleteComment,
}: Readonly<{
    isDark: boolean;
    isMobile: boolean;
}> &
    DiffCommentHandlers) {
    const commentsField = StateField.define({
        create() {
            return Decoration.none;
        },
        update(decorations, transaction) {
            const comments = transaction.effects.reduce<ReadonlyArray<ReviewComment> | undefined>(
                (latest, effect) => (effect.is(setReviewCommentsEffect) ? effect.value : latest),
                undefined,
            );
            if (!comments) {
                return decorations;
            }
            const doc = transaction.state.doc;
            return Decoration.set(
                comments
                    /** A comment left on a line the file no longer reaches has nowhere to go. */
                    .filter((comment) => comment.line >= 1 && comment.line <= doc.lines)
                    .map((comment) => {
                        return Decoration.widget({
                            widget: new ReviewCommentWidget(
                                comment,
                                onEditComment,
                                onDeleteComment,
                            ),
                            block: true,
                            side: 1,
                        }).range(doc.line(comment.line).to);
                    }),
                true,
            );
        },
        provide(field) {
            return EditorView.decorations.from(field);
        },
    });
    return [
        hoveredLineTracker,
        commentsField,
        commentingLineField,
        /**
         * Gutters render in facet order, and the line number gutter registers at default
         * precedence, so raising this one puts it at the far left edge.
         */
        Prec.high(
            gutter({
                class: 'agent-storm-comment-gutter',
                /** Desktop renders every line's button hidden, and hovering reveals one. */
                lineMarker(view, line) {
                    const isShown =
                        !isMobile ||
                        line.from === view.state.doc.lineAt(view.state.selection.main.head).from;
                    return isShown ? new AddCommentMarker(line.from, isMobile, onAddComment) : null;
                },
                lineMarkerChange(update) {
                    return isMobile && update.selectionSet;
                },
            }),
        ),
        EditorView.theme({
            /** One button wide, held there so it can't shift as the button moves between lines. */
            '.agent-storm-comment-gutter': {
                minWidth: isMobile ? '24px' : '14px',
                padding: '0',
            },
            '.agent-storm-comment-gutter .cm-gutterElement': {
                padding: '0',
                display: 'flex',
                alignItems: 'center',
            },
            [`.${addCommentButtonClass}`]: {
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: '0',
                width: isMobile ? '22px' : '14px',
                height: isMobile ? '22px' : '14px',
                padding: '0',
                cursor: 'pointer',
                borderRadius: '3px',
                border: `1px solid ${viraThemeByKeys.grey.foreground.decoration.foreground.value.cssText}`,
                background: viraThemeByKeys.grey['behind-fg'].body.background.value.cssText,
                color: viraThemeByKeys.grey.foreground.body.foreground.value.cssText,
            },
            ...(isMobile
                ? {}
                : {
                      [`.${addCommentButtonClass}:not([${hoveredMarkerAttribute}])`]: {
                          visibility: 'hidden',
                      },
                  }),
            /**
             * `!important` because the diff color themes reach these lines and their changed-text
             * spans through selectors with more classes than this rule can name.
             */
            '.agent-storm-commenting-line': {
                background: isDark
                    ? 'rgba(255, 210, 0, 0.3) !important'
                    : 'rgba(255, 220, 0, 0.5) !important',
            },
            /**
             * The unified view tints an inserted line through a span inside it, not the line
             * itself.
             */
            '.agent-storm-commenting-line .cm-insertedLine, .agent-storm-commenting-line .cm-changedText, .agent-storm-commenting-line .cm-deletedText':
                {
                    background: 'none !important',
                },
            '.agent-storm-review-comment': {
                display: 'flex',
                alignItems: 'flex-start',
                gap: '4px',
                padding: '6px 8px',
                borderTop: isDark
                    ? '1px solid rgba(120, 170, 255, 0.35)'
                    : '1px solid rgba(30, 100, 220, 0.3)',
                borderBottom: isDark
                    ? '1px solid rgba(120, 170, 255, 0.35)'
                    : '1px solid rgba(30, 100, 220, 0.3)',
                background: isDark ? 'rgba(120, 170, 255, 0.12)' : 'rgba(30, 100, 220, 0.07)',
                fontFamily: 'system-ui, sans-serif',
            },
            '.agent-storm-review-comment-body': {
                flexGrow: '1',
                whiteSpace: 'pre-wrap',
                overflowWrap: 'anywhere',
            },
        }),
    ];
}
