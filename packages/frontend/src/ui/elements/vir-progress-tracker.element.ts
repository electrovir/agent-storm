import {type FolderInfo} from '@agent-storm/common';
import {css, defineElement, defineElementEvent, html, listen} from 'element-vir';
import {parseUrl} from 'url-vir';
import {
    markWorktreeReviewed,
    setWorktreeMergeStep,
    stageTrivialHunks,
    startWorktreeTestServer,
} from '../../util/api-client.js';
import {openInVsCode} from '../../util/electron-bridge.js';
import {
    areStepDepsSatisfied,
    buildMergeStepInputs,
    evaluateMergeStep,
    isAnyMergeStepLoading,
    mergeStepsConfig,
    type MergeStepActions,
} from './merge-steps.js';

export {isAnyMergeStepLoading};

/**
 * One-time best-effort cleanup of pre-backend per-step localStorage keys. Two generations exist:
 *   - `agent-storm:progress:*` (single-integer count, original implementation)
 *   - `agent-storm:merge-step:*` (per-step boolean, removed when storage moved to the backend)
 * Both are dropped on first render so they don't accumulate forever on returning clients.
 */
let legacyPruned = false;
function pruneLegacyProgressKeys(): void {
    if (legacyPruned) {
        return;
    }
    legacyPruned = true;
    try {
        const toRemove: string[] = [];
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (
                key &&
                (key.startsWith('agent-storm:progress:') ||
                    key.startsWith('agent-storm:merge-step:'))
            ) {
                toRemove.push(key);
            }
        }
        toRemove.forEach((key) => localStorage.removeItem(key));
    } catch {
        /* private mode / quota errors — non-fatal */
    }
}

/**
 * github.com-only allow-list. Used before we hand a `prUrl` to the embed overlay so a malformed
 * or non-GitHub URL never reaches the webview tag.
 */
function sanitizePrUrl(prUrl: string | null): string | null {
    if (!prUrl) {
        return null;
    }
    const parsed = parseUrl(prUrl);
    const isHttp = parsed.protocol === 'https' || parsed.protocol === 'http';
    if (!isHttp || parsed.hostname !== 'github.com') {
        return null;
    }
    return prUrl;
}

export const VirProgressTracker = defineElement<{
    folder: FolderInfo;
}>()({
    tagName: 'vir-progress-tracker',
    events: {
        /** Emitted when a PR-link step is clicked. Detail is the github.com-allowlisted URL. */
        prEmbedRequested: defineElementEvent<string>(),
    },
    state() {
        return {
            /**
             * Optimistic overrides for per-step booleans. Set the instant a popover toggle is
             * clicked so the checkmark flips visually with zero latency, even before the
             * backend has acknowledged the write or the next `/folders` poll has landed. The
             * entry is removed once the API call resolves (success OR failure) — on failure,
             * the UI snaps back to the server-side value and the parent's error reporter
             * surfaces the underlying problem.
             *
             * Keyed by storage key (the step's `name`), not folder path: this component is
             * unmounted/remounted as the active folder changes, so the override map is
             * already scoped to the current folder.
             */
            pendingMergeStepValues: {} as Record<string, boolean>,
            /**
             * Name of the step whose popover is currently open, or null when no popover is
             * showing. Popovers only open on explicit click (no hover); clicking the same step
             * again, picking a menu item, clicking outside, or pressing Escape closes them.
             */
            openPopoverStep: null as string | null,
            /** Document-level listener handles, kept so cleanup can detach them. */
            outsideClickListener: undefined as ((event: MouseEvent) => void) | undefined,
            keydownListener: undefined as ((event: KeyboardEvent) => void) | undefined,
        };
    },
    init({state, updateState, host}) {
        const outsideClickListener = (event: MouseEvent) => {
            if (!state.openPopoverStep) {
                return;
            }
            const path = event.composedPath();
            // composedPath crosses shadow boundaries — if the click is anywhere inside this
            // component, leave the popover state alone (the per-button handlers handle it);
            // otherwise close.
            if (path.includes(host)) {
                return;
            }
            updateState({openPopoverStep: null});
        };
        const keydownListener = (event: KeyboardEvent) => {
            if (event.key === 'Escape' && state.openPopoverStep) {
                updateState({openPopoverStep: null});
            }
        };
        document.addEventListener('mousedown', outsideClickListener);
        document.addEventListener('keydown', keydownListener);
        updateState({outsideClickListener, keydownListener});
    },
    cleanup({state}) {
        if (state.outsideClickListener) {
            document.removeEventListener('mousedown', state.outsideClickListener);
        }
        if (state.keydownListener) {
            document.removeEventListener('keydown', state.keydownListener);
        }
    },
    styles: css`
        :host {
            display: block;
            padding: 14px 24px 16px;
            border-top: 1px solid var(--border);
            background: var(--bg-subtle);
            font-family: var(--font-body);
            flex-shrink: 0;
        }

        .stepper {
            position: relative;
            display: flex;
            justify-content: space-between;
            align-items: flex-start;
        }

        .track,
        .fill {
            position: absolute;
            top: 10px;
            height: 2px;
            border-radius: 1px;
            pointer-events: none;
        }

        .track {
            left: calc(100% / 14);
            right: calc(100% / 14);
            background: var(--border);
        }

        .fill {
            left: calc(100% / 14);
            background: var(--copper);
            transition: width 220ms ease;
        }

        .step {
            position: relative;
            z-index: 1;
            flex: 1 1 0;
            min-width: 0;
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 8px;
            background: none;
            border: 0;
            padding: 0;
            cursor: pointer;
            color: var(--fg-muted);
            font: inherit;
            opacity: 0.55;
            transition: opacity 160ms ease;
        }

        .step[data-done],
        .step[data-current] {
            opacity: 1;
        }

        .step:focus {
            outline: none;
        }

        .step:focus-visible .node {
            box-shadow: 0 0 0 3px color-mix(in srgb, var(--copper) 35%, transparent);
        }

        .node {
            width: 22px;
            height: 22px;
            border-radius: 50%;
            border: 2px solid var(--border);
            background: var(--bg-subtle);
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 11px;
            font-weight: 600;
            font-feature-settings: 'tnum';
            line-height: 1;
            color: var(--fg-muted);
            transition:
                background 160ms ease,
                border-color 160ms ease,
                color 160ms ease;
        }

        .step:hover {
            opacity: 1;
        }

        .step:hover .node {
            border-color: var(--copper);
        }

        .step[data-done] .node {
            background: var(--copper);
            border-color: var(--copper);
            color: var(--bg);
        }

        .step[data-current] .node {
            border-color: var(--copper);
            color: var(--copper);
        }

        /*
         * Loading: animated spinner inside the node. The node itself keeps its border so the
         * step still occupies the same visual footprint; the spinner is a sub-element that
         * spins independently. Opacity is forced to full so the .55 default doesn't dim the
         * spinner — a loading step is informative, not skipped.
         */
        .step[data-loading] {
            opacity: 1;
        }

        .step[data-loading] .node {
            border-color: var(--copper);
            background: var(--bg-subtle);
            color: var(--copper);
        }

        .spinner {
            display: block;
            width: 12px;
            height: 12px;
            border-radius: 50%;
            border: 2px solid color-mix(in srgb, var(--copper) 25%, transparent);
            border-top-color: var(--copper);
            animation: vir-progress-spin 720ms linear infinite;
        }

        @keyframes vir-progress-spin {
            to {
                transform: rotate(360deg);
            }
        }

        /*
         * Failure: solid red node with an exclamation glyph. Same visual weight as a done
         * checkmark so a failed step reads as decisive — the user should look at it. The
         * step label flips to the warning hue to match the node and pull the eye downward.
         */
        .step[data-failed] {
            opacity: 1;
        }

        .step[data-failed] .node {
            background: var(--danger, #d9534f);
            border-color: var(--danger, #d9534f);
            color: var(--bg, #fff);
            font-size: 13px;
        }

        .step[data-failed] .label {
            color: var(--danger, #d9534f);
            font-weight: 500;
        }

        .label {
            font-size: 11px;
            line-height: 1.3;
            text-align: center;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            max-width: 100%;
            color: var(--fg-muted);
            transition: color 160ms ease;
        }

        .step[data-done] .label {
            color: var(--fg);
        }

        .step[data-current] .label {
            color: var(--copper);
            font-weight: 500;
        }

        .step-wrap {
            position: relative;
            flex: 1 1 0;
            min-width: 0;
            display: flex;
            justify-content: center;
        }

        .step-wrap .step {
            width: 100%;
        }

        .popover {
            position: absolute;
            bottom: calc(100% + 8px);
            left: 50%;
            transform: translateX(-50%);
            display: flex;
            flex-direction: column;
            min-width: 168px;
            background: var(--bg);
            border: 1px solid var(--border);
            border-radius: var(--radius-md, 6px);
            box-shadow: 0 6px 18px rgba(0, 0, 0, 0.18);
            padding: 4px;
            z-index: 5;
            opacity: 0;
            pointer-events: none;
            transition: opacity 120ms ease;
        }

        /*
         * Popovers are click-driven: clicking a step with popoverActions sets data-open on the
         * wrapper, which reveals the menu. Click the same step again, an item, anywhere else,
         * or press Escape to close. No hover-reveal — sliding over a step button leaves it
         * alone.
         */
        .step-wrap[data-open] .popover {
            opacity: 1;
            pointer-events: auto;
        }

        .popover-item {
            background: none;
            border: 0;
            padding: 8px 10px;
            text-align: left;
            font: inherit;
            font-size: 12px;
            color: var(--fg);
            border-radius: 4px;
            cursor: pointer;
            white-space: nowrap;
        }

        .popover-item:hover,
        .popover-item:focus-visible {
            background: color-mix(in srgb, var(--copper) 12%, transparent);
            color: var(--copper);
            outline: none;
        }

        .popover-arrow {
            position: absolute;
            top: 100%;
            left: 50%;
            transform: translateX(-50%);
            width: 10px;
            height: 6px;
            background: var(--bg);
            border-right: 1px solid var(--border);
            border-bottom: 1px solid var(--border);
            clip-path: polygon(0 0, 100% 0, 50% 100%);
        }
    `,
    render({inputs, state, updateState, dispatch, events}) {
        pruneLegacyProgressKeys();

        const folder = inputs.folder;
        const folderPath = folder.path;

        // Resolve each step's inputs + raw done/failed/loading state via the shared helpers.
        // We compute raw states first (no dep-masking) so deps can resolve against optimistic
        // done values — checking "Open PR" reveals Reviewer-approved in the same frame, no
        // wait for the next /folders poll.
        const rawResolved = mergeStepsConfig.map((step) => {
            const optimistic =
                step.storageKey != null
                    ? state.pendingMergeStepValues[step.storageKey]
                    : undefined;
            const stepInputs = buildMergeStepInputs(folder, step, optimistic);
            const {done, failed, loading} = evaluateMergeStep(folder, step, optimistic);
            return {step, inputs: stepInputs, done, failed, loading};
        });
        const doneByName: Record<string, boolean> = {};
        for (const entry of rawResolved) doneByName[entry.step.name] = entry.done;
        // Mask state for steps whose deps aren't yet satisfied: render as plain unchecked
        // (no check / ! / spinner / current-emphasis). The step stays visible so the user
        // can see the upcoming work, just without misleading indicators.
        const resolved = rawResolved.map((entry) => {
            const depsSatisfied = areStepDepsSatisfied(entry.step, doneByName);
            if (depsSatisfied) return {...entry, depsSatisfied};
            return {
                ...entry,
                depsSatisfied,
                done: false,
                failed: false,
                loading: false,
            };
        });

        // `current` (the emphasized "you're here" step) is the first not-done step that
        // also has its deps satisfied — a step the user can't act on yet shouldn't grab
        // the spotlight.
        const firstNotDone = resolved.findIndex((entry) => !entry.done && entry.depsSatisfied);
        const doneCount = resolved.filter((entry) => entry.done).length;
        const fillRatio =
            doneCount >= 1 ? (doneCount - 1) / Math.max(1, mergeStepsConfig.length - 1) : 0;

        return html`
            <div class="stepper" role="group" aria-label="PR progress">
                <div class="track"></div>
                <div
                    class="fill"
                    style="width: calc(${fillRatio} * (100% - 100% / ${mergeStepsConfig.length}))"
                ></div>
                ${resolved.map(({step, inputs: stepInputs, done, failed, loading}, index) => {
                    const current = index === firstNotDone;
                    const label = done ? step.doneLabel : step.todoLabel;
                    const actions: MergeStepActions = {
                        toggleStored: () => {
                            if (step.storageKey == null) {
                                return;
                            }
                            const storageKey = step.storageKey;
                            const next = !done;
                            // Flip the override immediately so the checkmark updates in the
                            // same frame as the click. The override is cleared once the API
                            // call settles — success means the next /folders poll will deliver
                            // the same value; failure means the server-side value re-asserts
                            // itself and the user can see the click didn't take.
                            updateState({
                                pendingMergeStepValues: {
                                    ...state.pendingMergeStepValues,
                                    [storageKey]: next,
                                },
                            });
                            void setWorktreeMergeStep({
                                worktreePath: folderPath,
                                name: storageKey,
                                value: next,
                            })
                                .catch((error: unknown) => {
                                    console.error('setWorktreeMergeStep failed', error);
                                })
                                .finally(() => {
                                    const cleared = {...state.pendingMergeStepValues};
                                    delete cleared[storageKey];
                                    updateState({pendingMergeStepValues: cleared});
                                });
                        },
                        embedPr: () => {
                            const safeUrl = sanitizePrUrl(folder.prUrl ?? null);
                            if (safeUrl) {
                                dispatch(new events.prEmbedRequested(safeUrl));
                            }
                        },
                        openInVsCode: () => {
                            void openInVsCode(folderPath);
                        },
                        setLastReviewedSha: (sha) => {
                            void markWorktreeReviewed({
                                worktreePath: folderPath,
                                sha,
                            }).catch((error: unknown) => {
                                console.error('markWorktreeReviewed failed', error);
                            });
                        },
                        runTestLocally: () => {
                            // First click on a worktree spawns `npm start` and waits for it
                            // to print a localhost URL — that can take a while on cold caches,
                            // so the click resolves async with no inline progress UI. Console
                            // + global error reporter pick up the failure path; the success
                            // path drops straight into the embed overlay.
                            void startWorktreeTestServer({worktreePath: folderPath})
                                .then(({port}) => {
                                    dispatch(
                                        new events.prEmbedRequested(
                                            `http://localhost:${port}/`,
                                        ),
                                    );
                                })
                                .catch((error: unknown) => {
                                    console.error('startWorktreeTestServer failed', error);
                                });
                        },
                        stageTrivialHunks: () => {
                            void stageTrivialHunks({worktreePath: folderPath})
                                .then(({output}) => {
                                    console.info(`[stage-trivial-hunks @ ${folderPath}]\n${output}`);
                                })
                                .catch((error: unknown) => {
                                    console.error('stageTrivialHunks failed', error);
                                });
                        },
                    };
                    const nodeContents = done
                        ? '✓'
                        : failed
                          ? '!'
                          : loading
                            ? html`<span class="spinner" aria-hidden="true"></span>`
                            : index + 1;
                    const hasPopover = !!step.popoverActions && step.popoverActions.length > 0;
                    const popoverOpen = hasPopover && state.openPopoverStep === step.name;
                    const button = html`
                        <button
                            type="button"
                            class="step"
                            data-step=${step.name}
                            ?data-done=${done}
                            ?data-current=${current}
                            ?data-loading=${loading}
                            ?data-failed=${failed}
                            aria-pressed=${done ? 'true' : 'false'}
                            aria-haspopup=${hasPopover ? 'menu' : 'false'}
                            aria-expanded=${hasPopover ? (popoverOpen ? 'true' : 'false') : 'false'}
                            title=${label}
                            ${listen('click', () => {
                                if (hasPopover) {
                                    // Toggle: clicking the open step closes its popover; clicking
                                    // a different step switches to that step's popover.
                                    updateState({
                                        openPopoverStep: popoverOpen ? null : step.name,
                                    });
                                    return;
                                }
                                step.onClick(stepInputs, actions);
                            })}
                        >
                            <span class="node" aria-hidden="true">${nodeContents}</span>
                            <span class="label">${label}</span>
                        </button>
                    `;
                    if (!hasPopover) {
                        return button;
                    }
                    return html`
                        <div class="step-wrap" ?data-open=${popoverOpen}>
                            ${button}
                            <div class="popover" role="menu">
                                ${step.popoverActions!.map((entry) => {
                                    const resolvedLabel =
                                        typeof entry.label === 'function'
                                            ? entry.label(stepInputs)
                                            : entry.label;
                                    return html`
                                        <button
                                            type="button"
                                            class="popover-item"
                                            role="menuitem"
                                            ${listen('click', () => {
                                                entry.onClick(stepInputs, actions);
                                                updateState({openPopoverStep: null});
                                            })}
                                        >
                                            ${resolvedLabel}
                                        </button>
                                    `;
                                })}
                                <div class="popover-arrow" aria-hidden="true"></div>
                            </div>
                        </div>
                    `;
                })}
            </div>
        `;
    },
});
