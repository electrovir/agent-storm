// cspell:words hooray, Meslo, Menlo, unresolve

import {
    GitHubCheckState,
    GitHubCommentTarget,
    GitHubPrState,
    GitHubReaction,
    GitHubReviewState,
    type GitHubCheck,
    type GitHubComment,
    type GitHubPr,
    type GitHubReviewThread,
} from '@agent-storm/common';
import {check} from '@augment-vir/assert';
import {colorCss} from '@electrovir/color';
import {getNowInUserTimezone, maybeCreateFullDate, toRelativeString, utcTimezone} from 'date-vir';
import {
    css,
    defineElement,
    html,
    listen,
    repeat,
    unsafeHTML,
    type CSSResult,
    type HtmlInterpolation,
} from 'element-vir';
import {
    createSizedIcon,
    HorizontalAnchor,
    lucideIcons,
    renderMenuItemEntries,
    ViraButton,
    ViraColorVariant,
    ViraEmphasis,
    ViraIcon,
    ViraMenuTrigger,
    ViraSize,
    viraThemeByKeys,
    type ViraIconSvg,
} from 'vira';
import {
    getGitHubPr,
    postGitHubComment,
    setGitHubReaction,
    setGitHubThreadResolved,
} from '../../util/api-client.js';
import {reportRenderError} from '../../util/client-error-log.js';
import {sanitizeGitHubHtml} from '../../util/github-markdown.js';
import {ScreenSize} from '../../util/screen-size.js';

/**
 * How often the pane re-reads the PR while it's the visible tab. Far slower than the diff pane's
 * local `git status` loop because every refresh is a GraphQL call against GitHub's hourly point
 * budget. Opening the tab always refreshes, so this interval only covers a pane left sitting open.
 */
const refreshIntervalMs = 5 * 60 * 1000;

const stateLabels: Readonly<Record<GitHubPrState, string>> = {
    [GitHubPrState.Draft]: 'Draft',
    [GitHubPrState.Open]: 'Open',
    [GitHubPrState.Merged]: 'Merged',
    [GitHubPrState.Closed]: 'Closed',
};

const stateColors: Readonly<Record<GitHubPrState, CSSResult>> = {
    [GitHubPrState.Draft]: viraThemeByKeys.grey.foreground.header.foreground.value,
    [GitHubPrState.Open]: viraThemeByKeys.green.foreground.header.foreground.value,
    [GitHubPrState.Merged]: viraThemeByKeys.blue.foreground.header.foreground.value,
    [GitHubPrState.Closed]: viraThemeByKeys.red.foreground.header.foreground.value,
};

const stateIcons: Readonly<Record<GitHubPrState, ViraIconSvg>> = {
    [GitHubPrState.Draft]: createSizedIcon(lucideIcons.GitPullRequestDraft, 14),
    [GitHubPrState.Open]: createSizedIcon(lucideIcons.GitPullRequest, 14),
    [GitHubPrState.Merged]: createSizedIcon(lucideIcons.GitMerge, 14),
    [GitHubPrState.Closed]: createSizedIcon(lucideIcons.CircleX, 14),
};

const checkLabels: Readonly<Record<GitHubCheckState, string>> = {
    [GitHubCheckState.None]: 'Skipped',
    [GitHubCheckState.Pending]: 'Running',
    [GitHubCheckState.Success]: 'Passed',
    [GitHubCheckState.Failure]: 'Failed',
};

const checkColors: Readonly<Record<GitHubCheckState, CSSResult>> = {
    [GitHubCheckState.None]: viraThemeByKeys.grey.foreground.header.foreground.value,
    [GitHubCheckState.Pending]: viraThemeByKeys.yellow.foreground.header.foreground.value,
    [GitHubCheckState.Success]: viraThemeByKeys.green.foreground.header.foreground.value,
    [GitHubCheckState.Failure]: viraThemeByKeys.red.foreground.header.foreground.value,
};

const checkIcons: Readonly<Record<GitHubCheckState, ViraIconSvg>> = {
    [GitHubCheckState.None]: createSizedIcon(lucideIcons.CircleSlash, 14),
    [GitHubCheckState.Pending]: createSizedIcon(lucideIcons.Clock, 14),
    [GitHubCheckState.Success]: createSizedIcon(lucideIcons.CircleCheck, 14),
    [GitHubCheckState.Failure]: createSizedIcon(lucideIcons.CircleX, 14),
};

const reviewLabels: Readonly<Record<GitHubReviewState, string>> = {
    [GitHubReviewState.Approved]: 'approved',
    [GitHubReviewState.ChangesRequested]: 'requested changes',
    [GitHubReviewState.Commented]: 'commented',
    [GitHubReviewState.Dismissed]: 'dismissed',
    [GitHubReviewState.Pending]: 'pending',
};

const reviewColors: Readonly<Record<GitHubReviewState, CSSResult>> = {
    [GitHubReviewState.Approved]: viraThemeByKeys.green.foreground.header.foreground.value,
    [GitHubReviewState.ChangesRequested]: viraThemeByKeys.red.foreground.header.foreground.value,
    [GitHubReviewState.Commented]: viraThemeByKeys.grey.foreground.header.foreground.value,
    [GitHubReviewState.Dismissed]: viraThemeByKeys.grey.foreground.header.foreground.value,
    [GitHubReviewState.Pending]: viraThemeByKeys.yellow.foreground.header.foreground.value,
};

const reviewIcons: Readonly<Record<GitHubReviewState, ViraIconSvg>> = {
    [GitHubReviewState.Approved]: createSizedIcon(lucideIcons.CircleCheck, 14),
    [GitHubReviewState.ChangesRequested]: createSizedIcon(lucideIcons.CircleAlert, 14),
    [GitHubReviewState.Commented]: createSizedIcon(lucideIcons.MessageSquareText, 14),
    [GitHubReviewState.Dismissed]: createSizedIcon(lucideIcons.CircleSlash, 14),
    [GitHubReviewState.Pending]: createSizedIcon(lucideIcons.CircleDashed, 14),
};

const refreshIcon = createSizedIcon(lucideIcons.RefreshCw, 14);
const openExternalIcon = createSizedIcon(lucideIcons.ExternalLink, 14);

const reactionEmoji: Readonly<Record<GitHubReaction, string>> = {
    [GitHubReaction.ThumbsUp]: '👍',
    [GitHubReaction.ThumbsDown]: '👎',
    [GitHubReaction.Laugh]: '😄',
    [GitHubReaction.Hooray]: '🎉',
    [GitHubReaction.Confused]: '😕',
    [GitHubReaction.Heart]: '❤️',
    [GitHubReaction.Rocket]: '🚀',
    [GitHubReaction.Eyes]: '👀',
};

/** Menu labels for the reaction picker, since the emoji alone is a small tap target. */
const reactionNames: Readonly<Record<GitHubReaction, string>> = {
    [GitHubReaction.ThumbsUp]: 'thumbs up',
    [GitHubReaction.ThumbsDown]: 'thumbs down',
    [GitHubReaction.Laugh]: 'laugh',
    [GitHubReaction.Hooray]: 'hooray',
    [GitHubReaction.Confused]: 'confused',
    [GitHubReaction.Heart]: 'heart',
    [GitHubReaction.Rocket]: 'rocket',
    [GitHubReaction.Eyes]: 'eyes',
};

const allReactions: ReadonlyArray<GitHubReaction> = [
    GitHubReaction.ThumbsUp,
    GitHubReaction.ThumbsDown,
    GitHubReaction.Laugh,
    GitHubReaction.Hooray,
    GitHubReaction.Confused,
    GitHubReaction.Heart,
    GitHubReaction.Rocket,
    GitHubReaction.Eyes,
];

/** Failing first, then still-running, so the ones that need attention are at the top. */
const checkSortOrder: Readonly<Record<GitHubCheckState, number>> = {
    [GitHubCheckState.Failure]: 0,
    [GitHubCheckState.Pending]: 1,
    [GitHubCheckState.Success]: 2,
    [GitHubCheckState.None]: 3,
};

/** "3 hours ago" for a GitHub UTC ISO timestamp; the raw string if it doesn't parse. */
function relativeTime(isoTimestamp: string): string {
    const created = maybeCreateFullDate(isoTimestamp, utcTimezone);
    if (!created) {
        return isoTimestamp;
    }
    /**
     * `start` is now and `end` is the timestamp: the diff runs end minus start, so a past comment
     * has to be the end of the range to come out negative and read as "3 hours ago".
     */
    return toRelativeString(
        {
            start: getNowInUserTimezone(),
            end: created,
        },
        {
            days: true,
            hours: true,
            minutes: true,
        },
        {
            useOnlyLargestUnit: true,
            decimalCount: 0,
        },
    );
}

/** The name of the field every reply form posts, shared by the form and its submit handler. */
const replyFieldName = 'body';

function readReplyBody(form: HTMLFormElement): string {
    const value = new FormData(form).get(replyFieldName);
    return check.isString(value) ? value.trim() : '';
}

export const VirGithubPane = defineElement<{
    folder: string;
    /**
     * True when the GitHub tab is the visible one. Drives the refresh loop: a hidden pane holds no
     * timer, so a background folder never spends GitHub rate limit.
     */
    active: boolean;
    /** Mobile stacks the two columns; desktop puts reviews and checks in a fixed right rail. */
    screenSize: ScreenSize;
}>()({
    tagName: 'vir-github-pane',
    options: {
        errorHandler: reportRenderError,
    },
    state() {
        return {
            pr: undefined as GitHubPr | null | undefined,
            error: undefined as string | undefined,
            /**
             * True while a mutation is in flight. Disables every action button and suppresses the
             * refresh loop so a poll can't land a stale PR on top of a just-posted comment.
             */
            busy: false,
            /** True while a plain refresh is in flight, which spins the refresh button's icon. */
            refreshing: false,
            /** Resolved threads are hidden by default — they're the ones already dealt with. */
            showResolved: false,
            /** Passing checks are collapsed behind a count, matching github.com's merge box. */
            showPassingChecks: false,
            /**
             * Folder the live refresh timer was created for, or undefined when no timer is running.
             * Becoming visible and switching folders are the same event to this pane: tear the
             * timer down and re-arm it so the new interval closes over the current folder.
             */
            armedFolder: undefined as string | undefined,
            refreshTimer: undefined as ReturnType<typeof setInterval> | undefined,
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
            flex-direction: column;
            align-items: flex-start;
            gap: 4px;
            flex-grow: 0;
            flex-shrink: 0;
            padding: 6px 8px;
            border-bottom: 1px solid
                ${viraThemeByKeys.grey['behind-bg'].decoration.background.value};
        }

        .toolbar-actions {
            display: flex;
            align-items: center;
            gap: 8px;
        }

        .branch-line {
            font-size: 11px;
            font-family: 'MesloLGS NF', Menlo, monospace;
            color: ${viraThemeByKeys.grey.foreground['non-body'].foreground.value};
            overflow-wrap: anywhere;
        }

        /*
         * The whole button spins rather than just its icon: the icon lives inside ViraButton's own
         * shadow root, and at subtle emphasis the button is nothing but that icon anyway.
         */
        .refresh-button[data-spinning] {
            animation: spin 900ms linear infinite;
        }

        @keyframes spin {
            to {
                transform: rotate(360deg);
            }
        }

        .pr-title {
            max-width: 100%;
            overflow: hidden;
            white-space: nowrap;
            text-overflow: ellipsis;
            font-weight: 600;
            text-decoration: none;
            color: inherit;
        }

        .pr-title:hover {
            text-decoration: underline;
        }

        .pr-number {
            color: ${viraThemeByKeys.grey.foreground['non-body'].foreground.value};
            font-weight: 400;
        }

        .chip {
            display: inline-flex;
            align-items: center;
            gap: 4px;
            flex-grow: 0;
            flex-shrink: 0;
            padding: 2px 8px;
            border-radius: 999px;
            border: 1px solid currentColor;
            font-size: 11px;
            white-space: nowrap;
        }

        .columns {
            display: flex;
            flex-direction: row;
            align-items: stretch;
            flex-grow: 1;
            flex-shrink: 1;
            min-height: 0;
        }

        .columns[data-mobile] {
            flex-direction: column;
            overflow-y: auto;
        }

        .conversation-column {
            flex-grow: 1;
            flex-shrink: 1;
            min-width: 0;
            min-height: 0;
            overflow-y: auto;
            padding: 8px;
            display: flex;
            flex-direction: column;
            /* Centers the width-capped contents once the column is wider than the cap. */
            align-items: center;
            gap: 12px;
            background: ${viraThemeByKeys.grey['behind-fg']['small-body'].background.value};
        }

        /*
         * Comment text past ~1400px is unreadable, so the column's contents stop growing there even
         * on a wide monitor. The cap goes on an inner wrapper rather than the column itself so the
         * column keeps filling the flex row and its scrollbar stays at the pane's edge.
         */
        .conversation-width {
            display: flex;
            flex-direction: column;
            gap: 12px;
            width: 100%;
            max-width: 1400px;
        }

        .reviews-column {
            flex-grow: 0;
            flex-shrink: 0;
            box-sizing: border-box;
            width: 280px;
            min-height: 0;
            overflow-y: auto;
            padding: 8px;
            display: flex;
            flex-direction: column;
            gap: 12px;
            border-left: 1px solid ${viraThemeByKeys.grey['behind-bg'].decoration.background.value};
        }

        /*
         * Stacked on a phone: the review + checks summary reads first, then the conversation. Both
         * columns give up their own scroll containers so the whole pane scrolls as one.
         */
        .columns[data-mobile] .reviews-column {
            width: 100%;
            order: -1;
            overflow-y: visible;
            border-left: none;
            border-bottom: 1px solid
                ${viraThemeByKeys.grey['behind-bg'].decoration.background.value};
        }

        .columns[data-mobile] .conversation-column {
            overflow-y: visible;
        }

        .section-header {
            display: flex;
            align-items: center;
            gap: 8px;
            font-size: 10px;
            letter-spacing: 0.06em;
            text-transform: uppercase;
            color: ${viraThemeByKeys.grey.foreground['non-body'].foreground.value};
        }

        .reviewer {
            display: flex;
            align-items: center;
            gap: 6px;
            min-width: 0;
        }

        .reviewer-name {
            flex-grow: 1;
            flex-shrink: 1;
            min-width: 0;
            overflow: hidden;
            white-space: nowrap;
            text-overflow: ellipsis;
            font-weight: 600;
        }

        .reviewer-state {
            flex-grow: 0;
            flex-shrink: 0;
            display: inline-flex;
            align-items: center;
            gap: 4px;
            font-size: 11px;
        }

        .avatar {
            width: 18px;
            height: 18px;
            border-radius: 50%;
            flex-grow: 0;
            flex-shrink: 0;
            background: ${viraThemeByKeys.grey['behind-bg'].decoration.background.value};
        }

        .check-row {
            display: flex;
            align-items: center;
            gap: 6px;
            min-width: 0;
            text-decoration: none;
            color: inherit;
            padding: 2px 0;
        }

        .check-row[href]:hover .check-name {
            text-decoration: underline;
        }

        .check-name {
            flex-grow: 1;
            flex-shrink: 1;
            min-width: 0;
            overflow: hidden;
            white-space: nowrap;
            text-overflow: ellipsis;
        }

        .check-workflow {
            color: ${viraThemeByKeys.grey.foreground['non-body'].foreground.value};
        }

        .check-summary {
            display: flex;
            align-items: center;
            flex-wrap: wrap;
            gap: 8px;
            font-size: 11px;
        }

        .card {
            display: flex;
            flex-direction: column;
            gap: 8px;
            padding: 8px;
            border-radius: 6px;
            border: 1px solid ${viraThemeByKeys.grey['behind-bg'].decoration.background.value};
            /* Lifts each card off the conversation column's grey. */
            background: ${viraThemeByKeys.grey['behind-fg']['highest-contrast'].background.value};
        }

        .card[data-resolved] {
            opacity: 0.6;
        }

        .thread-header {
            display: flex;
            align-items: center;
            gap: 8px;
            flex-wrap: wrap;
        }

        .thread-path {
            flex-grow: 1;
            flex-shrink: 1;
            min-width: 0;
            overflow-wrap: anywhere;
            font-family: 'MesloLGS NF', Menlo, monospace;
            font-size: 11px;
            color: ${viraThemeByKeys.blue.foreground.body.foreground.value};
        }

        .diff-hunk {
            margin: 0;
            padding: 6px 8px;
            border-radius: 4px;
            overflow-x: auto;
            white-space: pre;
            font-family: 'MesloLGS NF', Menlo, monospace;
            font-size: 11px;
            ${colorCss(viraThemeByKeys.grey['behind-fg']['small-body'])};
        }

        .comment {
            display: flex;
            flex-direction: column;
            gap: 4px;
        }

        .comment + .comment {
            padding-top: 8px;
            border-top: 1px solid ${viraThemeByKeys.grey['behind-bg'].invisible.background.value};
        }

        .comment-header {
            display: flex;
            align-items: center;
            gap: 6px;
            font-size: 11px;
            color: ${viraThemeByKeys.grey.foreground['non-body'].foreground.value};
        }

        .comment-author {
            font-weight: 600;
            color: ${viraThemeByKeys.grey.foreground.body.foreground.value};
        }

        /*
         * Styling for GitHub's rendered markdown (see sanitizeGitHubHtml). The element tree here is
         * whatever github.com emits, so these rules are element selectors rather than classes.
         */
        .markdown {
            overflow-wrap: anywhere;
            font-size: 13px;
        }

        .markdown > *:first-child {
            margin-top: 0;
        }

        .markdown > *:last-child {
            margin-bottom: 0;
        }

        .markdown p,
        .markdown ul,
        .markdown ol,
        .markdown blockquote,
        .markdown table {
            margin: 6px 0;
        }

        .markdown ul,
        .markdown ol {
            padding-left: 20px;
        }

        .markdown h1,
        .markdown h2,
        .markdown h3,
        .markdown h4 {
            margin: 10px 0 4px;
            font-size: 14px;
        }

        .markdown code {
            padding: 1px 4px;
            border-radius: 4px;
            font-family: 'MesloLGS NF', Menlo, monospace;
            font-size: 11px;
            ${colorCss(viraThemeByKeys.grey['behind-fg']['small-body'])};
        }

        .markdown pre {
            margin: 6px 0;
            padding: 8px;
            border-radius: 4px;
            overflow-x: auto;
            ${colorCss(viraThemeByKeys.grey['behind-fg']['small-body'])};
        }

        .markdown pre code {
            padding: 0;
            background: none;
        }

        .markdown blockquote {
            padding-left: 8px;
            border-left: 3px solid ${viraThemeByKeys.grey['behind-bg'].decoration.background.value};
            color: ${viraThemeByKeys.grey.foreground['non-body'].foreground.value};
        }

        .markdown img {
            max-width: 100%;
        }

        .markdown table {
            border-collapse: collapse;
        }

        .markdown th,
        .markdown td {
            padding: 2px 6px;
            border: 1px solid ${viraThemeByKeys.grey['behind-bg'].decoration.background.value};
        }

        .markdown a {
            color: ${viraThemeByKeys.blue.foreground.body.foreground.value};
        }

        /* Collapsible sections are native <details>; no script needed to expand them. */
        .markdown details {
            margin: 6px 0;
            padding: 6px 8px;
            border-radius: 4px;
            border: 1px solid ${viraThemeByKeys.grey['behind-bg'].decoration.background.value};
        }

        .markdown summary {
            cursor: pointer;
            font-weight: 600;
        }

        .markdown details[open] summary {
            margin-bottom: 6px;
        }

        /* GitHub emits task lists as a plain <ul> whose items lead with a disabled checkbox. */
        .markdown li:has(> input[type='checkbox']) {
            list-style: none;
            margin-left: -20px;
        }

        .markdown input[type='checkbox'] {
            margin-right: 4px;
        }

        .markdown kbd {
            padding: 1px 4px;
            border-radius: 4px;
            border: 1px solid ${viraThemeByKeys.grey['behind-bg'].decoration.background.value};
            font-family: 'MesloLGS NF', Menlo, monospace;
            font-size: 11px;
        }

        .markdown hr {
            border: none;
            border-top: 1px solid ${viraThemeByKeys.grey['behind-bg'].decoration.background.value};
        }

        /* The title is one line of markdown, so only its inline code needs styling. */
        .pr-title code {
            padding: 1px 4px;
            border-radius: 4px;
            font-family: 'MesloLGS NF', Menlo, monospace;
            font-size: 11px;
            ${colorCss(viraThemeByKeys.grey['behind-fg']['small-body'])};
        }

        .reactions {
            display: flex;
            align-items: center;
            flex-wrap: wrap;
            gap: 4px;
        }

        .reaction {
            appearance: none;
            cursor: pointer;
            font: inherit;
            font-size: 11px;
            padding: 1px 8px;
            border-radius: 999px;
            border: 1px solid ${viraThemeByKeys.grey['behind-bg'].decoration.background.value};
            background: transparent;
            color: ${viraThemeByKeys.grey.foreground.body.foreground.value};
        }

        .reaction[data-mine] {
            border-color: ${viraThemeByKeys.blue.foreground.body.foreground.value};
            ${colorCss(viraThemeByKeys.blue['behind-fg']['small-body'])};
        }

        .reaction:disabled {
            cursor: default;
        }

        .reply-form {
            display: flex;
            flex-direction: column;
            gap: 6px;
        }

        textarea {
            box-sizing: border-box;
            width: 100%;
            min-height: 60px;
            resize: vertical;
            padding: 6px 8px;
            border-radius: 4px;
            border: 1px solid ${viraThemeByKeys.grey['behind-bg'].decoration.background.value};
            font-family: inherit;
            font-size: 13px;
            ${colorCss(viraThemeByKeys.grey.foreground.body)};
            background: transparent;
        }

        .reply-actions {
            display: flex;
            align-items: center;
            justify-content: flex-end;
            gap: 6px;
        }

        .message {
            padding: 16px;
            text-align: center;
            color: ${viraThemeByKeys.grey.foreground['non-body'].foreground.value};
        }

        .message[data-error] {
            color: ${viraThemeByKeys.red.foreground.body.foreground.value};
            white-space: pre-wrap;
            text-align: left;
        }
    `,
    render({inputs, state, updateState}) {
        /**
         * The server holds the PR cache, so an un-forced load is free while that cache is fresh —
         * opening the tab is a local round trip. `forceRefresh` is for the refresh button and for
         * the reload after a mutation, where stale data would look like the write didn't land.
         */
        const loadPr = (folder: string, forceRefresh = false) => {
            updateState({
                refreshing: true,
            });
            void getGitHubPr({
                folder,
                forceRefresh,
            })
                .then((pr) => {
                    updateState({
                        pr,
                        error: undefined,
                    });
                })
                .catch((error: unknown) => {
                    updateState({
                        error: error instanceof Error ? error.message : String(error),
                    });
                })
                .finally(() => {
                    updateState({
                        refreshing: false,
                    });
                });
        };

        /**
         * Arm the poll when the pane becomes visible, re-arm it on a folder switch, and tear it
         * down when the pane hides. Same single-field pattern the diff pane uses, for the same
         * reason: the interval callback has to close over the current folder.
         */
        if (inputs.active && state.armedFolder !== inputs.folder) {
            if (state.refreshTimer) {
                clearInterval(state.refreshTimer);
            }
            const folder = inputs.folder;
            updateState({
                armedFolder: folder,
                refreshTimer: setInterval(() => {
                    if (!state.busy) {
                        loadPr(folder, true);
                    }
                }, refreshIntervalMs),
            });
            loadPr(folder);
        } else if (!inputs.active && state.refreshTimer) {
            clearInterval(state.refreshTimer);
            updateState({
                armedFolder: undefined,
                refreshTimer: undefined,
            });
        }

        /** Every mutation ends in a reload, so the pane never has to patch its own copy of the PR. */
        const runMutation = (mutate: () => Promise<void>) => {
            updateState({
                busy: true,
            });
            void mutate()
                .then(() => {
                    updateState({
                        error: undefined,
                    });
                    return getGitHubPr({
                        folder: inputs.folder,
                        forceRefresh: true,
                    });
                })
                .then((pr) => {
                    updateState({
                        pr,
                    });
                })
                .catch((error: unknown) => {
                    updateState({
                        error: error instanceof Error ? error.message : String(error),
                    });
                })
                .finally(() => {
                    updateState({
                        busy: false,
                    });
                });
        };

        const onToggleReaction = (comment: Readonly<GitHubComment>, reaction: GitHubReaction) => {
            const existing = comment.reactions.find((group) => group.reaction === reaction);
            runMutation(() =>
                setGitHubReaction({
                    subjectId: comment.id,
                    reaction,
                    add: !existing?.viewerHasReacted,
                }),
            );
        };

        const onSubmitReply = (
            event: Readonly<SubmitEvent>,
            target: GitHubCommentTarget,
            subjectId: string,
        ) => {
            event.preventDefault();
            const form = event.currentTarget;
            if (!(form instanceof HTMLFormElement)) {
                return;
            }
            const body = readReplyBody(form);
            if (!body) {
                return;
            }
            form.reset();
            runMutation(() =>
                postGitHubComment({
                    target,
                    subjectId,
                    body,
                }),
            );
        };

        /**
         * Fall back to the raw markdown when GitHub didn't send a rendered body (an older cached
         * response, or a body that renders to nothing), so a comment is never silently blank.
         */
        const renderMarkdown = ({
            bodyHtml,
            body,
        }: Readonly<{bodyHtml: string; body: string}>) => html`
            <div class="markdown">
                ${bodyHtml ? unsafeHTML(sanitizeGitHubHtml(bodyHtml)) : body}
            </div>
        `;

        const renderReactions = (comment: Readonly<GitHubComment>) => html`
            <div class="reactions">
                ${comment.reactions.map(
                    (group) => html`
                        <button
                            type="button"
                            class="reaction"
                            ?data-mine=${group.viewerHasReacted}
                            ?disabled=${state.busy}
                            title=${group.viewerHasReacted ? 'Remove your reaction' : 'React'}
                            ${listen('click', () => onToggleReaction(comment, group.reaction))}
                        >
                            ${reactionEmoji[group.reaction]} ${group.count}
                        </button>
                    `,
                )}
                <${ViraMenuTrigger.assign({
                    horizontalAnchor: HorizontalAnchor.Left,
                })}>
                    <${ViraButton.assign({
                        buttonSize: ViraSize.Small,
                        buttonEmphasis: ViraEmphasis.Subtle,
                        color: ViraColorVariant.Neutral,
                        text: '+',
                        isDisabled: state.busy,
                    })}
                        slot=${ViraMenuTrigger.slotNames['vira-menu-trigger-trigger']}
                        title="Add a reaction"
                    ></${ViraButton}>
                    ${renderMenuItemEntries(
                        allReactions.map((reaction) => {
                            return {
                                content: `${reactionEmoji[reaction]} ${reactionNames[reaction]}`,
                                onClick: () => onToggleReaction(comment, reaction),
                            };
                        }),
                    )}
                </${ViraMenuTrigger}>
            </div>
        `;

        const renderCommentHeader = ({
            author,
            authorAvatarUrl,
            createdAt,
        }: Readonly<{
            author: string;
            authorAvatarUrl: string;
            createdAt: string;
        }>) => html`
            <div class="comment-header">
                ${authorAvatarUrl
                    ? html`
                          <img class="avatar" src=${authorAvatarUrl} alt="" />
                      `
                    : ''}
                <span class="comment-author">${author}</span>
                <span>${relativeTime(createdAt)}</span>
            </div>
        `;

        const renderComment = (comment: Readonly<GitHubComment>) => html`
            <div class="comment">
                ${renderCommentHeader(comment)} ${renderMarkdown(comment)}
                ${renderReactions(comment)}
            </div>
        `;

        /**
         * `leadingAction` sits to the submit button's left in the actions row — that's where a
         * thread's resolve control goes, so the two things you'd do to a thread are side by side.
         */
        const renderReplyForm = ({
            target,
            subjectId,
            placeholder,
            submitLabel,
            leadingAction,
        }: Readonly<{
            target: GitHubCommentTarget;
            subjectId: string;
            placeholder: string;
            submitLabel: string;
            leadingAction?: HtmlInterpolation | undefined;
        }>) => html`
            <form
                class="reply-form"
                ${listen('submit', (event) => onSubmitReply(event, target, subjectId))}
            >
                <textarea
                    name=${replyFieldName}
                    placeholder=${placeholder}
                    ?disabled=${state.busy}
                ></textarea>
                <div class="reply-actions">
                    ${leadingAction || ''}
                    <${ViraButton.assign({
                        buttonSize: ViraSize.Small,
                        color: ViraColorVariant.Info,
                        text: submitLabel,
                        isDisabled: state.busy,
                    })}
                        type="submit"
                    ></${ViraButton}>
                </div>
            </form>
        `;

        const renderThread = (thread: Readonly<GitHubReviewThread>) => html`
            <div class="card" ?data-resolved=${thread.isResolved}>
                <div class="thread-header">
                    <span class="thread-path">
                        ${thread.path}${thread.line == undefined ? '' : `:${thread.line}`}
                    </span>
                    ${thread.isOutdated
                        ? html`
                              <span class="chip">Outdated</span>
                          `
                        : ''}
                </div>
                ${thread.diffHunk
                    ? html`
                          <pre class="diff-hunk">${thread.diffHunk}</pre>
                      `
                    : ''}
                ${thread.comments.map((comment) => renderComment(comment))}
                ${renderReplyForm({
                    target: GitHubCommentTarget.Thread,
                    subjectId: thread.id,
                    placeholder: 'Reply…',
                    submitLabel: 'Reply',
                    leadingAction: html`
                        <${ViraButton.assign({
                            buttonSize: ViraSize.Small,
                            buttonEmphasis: ViraEmphasis.Subtle,
                            color: thread.isResolved
                                ? ViraColorVariant.Neutral
                                : ViraColorVariant.Info,
                            text: thread.isResolved ? 'Unresolve' : 'Resolve',
                            isDisabled: state.busy || !thread.viewerCanResolve,
                        })}
                            ${listen('click', () =>
                                runMutation(() =>
                                    setGitHubThreadResolved({
                                        threadId: thread.id,
                                        resolved: !thread.isResolved,
                                    }),
                                ),
                            )}
                        ></${ViraButton}>
                    `,
                })}
            </div>
        `;

        const renderCheck = (checkRun: Readonly<GitHubCheck>) => html`
            <a
                class="check-row"
                href=${checkRun.url || undefined}
                target="_blank"
                rel="noopener noreferrer"
                title=${checkRun.description || checkRun.name}
            >
                <${ViraIcon.assign({
                    icon: checkIcons[checkRun.state],
                })}
                    style=${css`
                        color: ${checkColors[checkRun.state]};
                    `}
                ></${ViraIcon}>
                <span class="check-name">
                    ${checkRun.workflow
                        ? html`
                              <span class="check-workflow">${checkRun.workflow} /</span>
                          `
                        : ''}
                    ${checkRun.name}
                </span>
            </a>
        `;

        if (state.error) {
            return html`
                <div class="message" data-error role="alert">${state.error}</div>
            `;
        } else if (state.pr === undefined) {
            return html`
                <div class="message">Loading pull request…</div>
            `;
        } else if (state.pr === null) {
            return html`
                <div class="message">This branch has no pull request.</div>
            `;
        }

        const pr = state.pr;
        const isMobile = inputs.screenSize === ScreenSize.Mobile;
        const visibleThreads = state.showResolved
            ? pr.threads
            : pr.threads.filter((thread) => !thread.isResolved);
        const resolvedCount = pr.threads.filter((thread) => thread.isResolved).length;
        /**
         * Outstanding requests go first and win over a submitted review by the same person: a
         * re-request means GitHub is waiting on them again, whatever they said last time.
         */
        const reviewRows = [
            ...pr.reviewRequests.map((request) => {
                return {
                    reviewer: request.reviewer,
                    avatarUrl: request.reviewerAvatarUrl,
                    reviewState: GitHubReviewState.Pending,
                };
            }),
            ...pr.reviews
                .filter(
                    (review) =>
                        !pr.reviewRequests.some((request) => request.reviewer === review.author),
                )
                .map((review) => {
                    return {
                        reviewer: review.author,
                        avatarUrl: review.authorAvatarUrl,
                        reviewState: review.state,
                    };
                }),
        ];
        const sortedChecks = pr.checkRuns.toSorted(
            (first, second) => checkSortOrder[first.state] - checkSortOrder[second.state],
        );
        const passingChecks = sortedChecks.filter(
            (checkRun) => checkRun.state === GitHubCheckState.Success,
        );
        /**
         * Passing checks collapse behind their count the way github.com's merge box does — a repo
         * with thirty green jobs shouldn't push the failing one off the screen.
         */
        const visibleChecks = state.showPassingChecks
            ? sortedChecks
            : sortedChecks.filter((checkRun) => checkRun.state !== GitHubCheckState.Success);
        const checkCounts = [
            GitHubCheckState.Failure,
            GitHubCheckState.Pending,
            GitHubCheckState.Success,
        ]
            .map((checkState) => {
                return {
                    checkState,
                    count: sortedChecks.filter((checkRun) => checkRun.state === checkState).length,
                };
            })
            .filter((entry) => entry.count > 0);

        return html`
            <div class="toolbar">
                <a
                    class="pr-title"
                    href=${pr.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    title=${pr.title}
                >
                    <span class="pr-number">#${pr.number}</span>
                    ${pr.titleHtml ? unsafeHTML(sanitizeGitHubHtml(pr.titleHtml)) : pr.title}
                </a>
                <div class="branch-line">${pr.headRefName} → ${pr.baseRefName}</div>
                <div class="toolbar-actions">
                    <span
                        class="chip"
                        style=${css`
                            color: ${stateColors[pr.state]};
                        `}
                    >
                        <${ViraIcon.assign({
                            icon: stateIcons[pr.state],
                        })}></${ViraIcon}>
                        ${stateLabels[pr.state]}
                    </span>
                    <${ViraButton.assign({
                        buttonSize: ViraSize.Small,
                        buttonEmphasis: ViraEmphasis.Subtle,
                        color: ViraColorVariant.Neutral,
                        icon: openExternalIcon,
                    })}
                        title="Open this PR on github.com"
                        ${listen('click', () => window.open(pr.url, '_blank', 'noopener'))}
                    ></${ViraButton}>
                    <${ViraButton.assign({
                        buttonSize: ViraSize.Small,
                        buttonEmphasis: ViraEmphasis.Subtle,
                        color: ViraColorVariant.Neutral,
                        icon: refreshIcon,
                        isDisabled: state.busy || state.refreshing,
                    })}
                        class="refresh-button"
                        ?data-spinning=${state.refreshing}
                        title="Refresh"
                        ${listen('click', () => loadPr(inputs.folder, true))}
                    ></${ViraButton}>
                </div>
            </div>
            <div class="columns" ?data-mobile=${isMobile}>
                <div class="conversation-column">
                    <div class="conversation-width">
                        ${pr.body || pr.bodyHtml
                            ? html`
                                  <div class="card">
                                      ${renderCommentHeader(pr)} ${renderMarkdown(pr)}
                                  </div>
                              `
                            : ''}
                        <div class="section-header">
                            Review threads (${visibleThreads.length})
                            ${resolvedCount
                                ? html`
                                      <${ViraButton.assign({
                                          buttonSize: ViraSize.Small,
                                          buttonEmphasis: ViraEmphasis.Subtle,
                                          color: ViraColorVariant.Neutral,
                                          text: state.showResolved
                                              ? `Hide ${resolvedCount} resolved`
                                              : `Show ${resolvedCount} resolved`,
                                      })}
                                          ${listen('click', () =>
                                              updateState({
                                                  showResolved: !state.showResolved,
                                              }),
                                          )}
                                      ></${ViraButton}>
                                  `
                                : ''}
                        </div>
                        ${visibleThreads.length
                            ? repeat(visibleThreads, (thread) => thread.id, renderThread)
                            : html`
                                  <div class="message">No review threads.</div>
                              `}
                        <div class="section-header">Conversation (${pr.comments.length})</div>
                        ${pr.comments.length
                            ? repeat(
                                  pr.comments,
                                  (comment) => comment.id,
                                  (comment) => html`
                                      <div class="card">${renderComment(comment)}</div>
                                  `,
                              )
                            : html`
                                  <div class="message">No comments yet.</div>
                              `}
                        <div class="card">
                            ${renderReplyForm({
                                target: GitHubCommentTarget.Conversation,
                                subjectId: pr.id,
                                placeholder: 'Comment on this pull request…',
                                submitLabel: 'Comment',
                            })}
                        </div>
                    </div>
                </div>
                <div class="reviews-column">
                    <div class="section-header">Reviews</div>
                    ${reviewRows.length
                        ? reviewRows.map(
                              ({reviewer, avatarUrl, reviewState}) => html`
                                  <div
                                      class="reviewer"
                                      title=${`${reviewer} ${reviewLabels[reviewState]}`}
                                  >
                                      <span
                                          class="reviewer-state"
                                          style=${css`
                                              color: ${reviewColors[reviewState]};
                                          `}
                                      >
                                          <${ViraIcon.assign({
                                              icon: reviewIcons[reviewState],
                                          })}></${ViraIcon}>
                                      </span>
                                      ${avatarUrl
                                          ? html`
                                                <img class="avatar" src=${avatarUrl} alt="" />
                                            `
                                          : ''}
                                      <span class="reviewer-name">${reviewer}</span>
                                  </div>
                              `,
                          )
                        : html`
                              <div class="message">No reviews yet.</div>
                          `}
                    <div class="section-header">
                        Checks
                        ${passingChecks.length
                            ? html`
                                  <${ViraButton.assign({
                                      buttonSize: ViraSize.Small,
                                      buttonEmphasis: ViraEmphasis.Subtle,
                                      color: ViraColorVariant.Neutral,
                                      text: state.showPassingChecks
                                          ? `Hide ${passingChecks.length} passing`
                                          : `Show ${passingChecks.length} passing`,
                                  })}
                                      ${listen('click', () =>
                                          updateState({
                                              showPassingChecks: !state.showPassingChecks,
                                          }),
                                      )}
                                  ></${ViraButton}>
                              `
                            : ''}
                    </div>
                    ${sortedChecks.length
                        ? html`
                              <div class="check-summary">
                                  ${checkCounts.map(
                                      ({checkState, count}) => html`
                                          <span
                                              class="reviewer-state"
                                              style=${css`
                                                  color: ${checkColors[checkState]};
                                              `}
                                          >
                                              <${ViraIcon.assign({
                                                  icon: checkIcons[checkState],
                                              })}></${ViraIcon}>
                                              ${count} ${checkLabels[checkState].toLowerCase()}
                                          </span>
                                      `,
                                  )}
                              </div>
                              ${visibleChecks.map((checkRun) => renderCheck(checkRun))}
                          `
                        : html`
                              <div class="message">No checks on the head commit.</div>
                          `}
                </div>
            </div>
        `;
    },
});
