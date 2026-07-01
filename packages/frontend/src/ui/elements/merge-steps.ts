import {PaneStatus, type FolderInfo} from '@agent-storm/common';

/**
 * Inputs evaluated for each step on every render. Mirrors `FolderInfo`'s merge-step fields plus the
 * per-step stored boolean. Steps with `storageKey: null` ignore `storedValue`.
 */
export type MergeStepInputs = {
    storedValue: boolean | undefined;
    folderPath: string;
    hasUncommittedChanges: boolean;
    localCommitHash: string | null;
    branchCommitHash: string | null;
    lastReviewedSha: string | null;
    prUrl: string | null;
    prMerged: boolean;
    prIsDraft: boolean;
    prCiPassing: boolean | null;
    prCiInProgress: boolean;
    /**
     * Aggregated review-check status — drives the "Get approval" step in place of GitHub's
     * `reviewDecision`. See `folderInfoShape.prReviewCheckPassing` for semantics.
     */
    prReviewCheckPassing: boolean | null;
    prReviewCheckInProgress: boolean;
    prApproved: boolean;
    prReviewChangesRequested: boolean;
    prReviewPending: boolean;
    /** Mirror of `folderInfoShape.prHasUnresolvedReviewComments` — see that field for semantics. */
    prHasUnresolvedReviewComments: boolean;
    /** Mirror of `folderInfoShape.prHasMergeConflicts` — see that field for semantics. */
    prHasMergeConflicts: boolean;
    /** Current status of the worktree's AI pane. Drives the "AI generating" step. */
    aiPaneStatus: PaneStatus;
};

/**
 * Side-effect channels handed to a step's `onClick`. Steps wire one or more of these explicitly —
 * there's no implicit "click means toggle" anymore. Each step decides what its click does.
 */
export type MergeStepActions = {
    /** Toggle the step's stored boolean. No-op when the step has `storageKey: null`. */
    toggleStored: () => void;
    /**
     * Open `prUrl` in a new tab (browser) or new in-app BrowserWindow (Electron). Silently no-ops
     * when `prUrl` is null or fails the github.com allow-list check.
     */
    /**
     * Ask the parent (vir-app) to embed `prUrl` fullscreen via vir-pr-embed. No-op when `prUrl` is
     * null or fails the github.com allow-list check.
     */
    embedPr: () => void;
    /** Launch VS Code on `folderPath` via the Electron bridge. No-op outside Electron. */
    openInVsCode: () => void;
    /**
     * Persist `lastReviewedSha` to the backend (writes through `/worktrees/mark-reviewed`). `null`
     * clears it. Fire-and-forget; failures land in the global client-error reporter.
     */
    setLastReviewedSha: (sha: string | null) => void;
    /**
     * Spin up (or reuse) the worktree's `npm start` and embed the detected frontend URL fullscreen
     * via the PR-embed overlay. Fires `prEmbedRequested` once the server reports a port; failures
     * land in the client-error reporter and a console message.
     */
    runTestLocally: () => void;
    /**
     * Run `scripts/stage-trivial-hunks.mjs` in the worktree and stage no-review-needed hunks
     * (whitespace, comment-only, import-only, lockfile-when-package-json-changed, css). The script
     * output is logged to the console; failures land in the client-error reporter.
     */
    stageTrivialHunks: () => void;
};

export type MergeStepConfigValue = {
    /** Stable identifier used in aria/data attributes. */
    name: string;
    /** Label rendered when `calculate` returns false (or before invalidation). */
    todoLabel: string;
    /** Label rendered when `calculate` returns true. */
    doneLabel: string;
    /**
     * Optional list of `name`s this step depends on. The step is always rendered in the stepper (so
     * the user sees the upcoming work) but until _every_ listed step's `calculate` is currently
     * true the node collapses to its plain unchecked state — no checkmark, no red-exclam, no
     * spinner, and it can't be the "current" focused step. Example: "Reviewer approved" sits as a
     * numbered grey circle until "Open PR" is done, then resumes normal done/failed/loading
     * rendering.
     */
    dependsOn?: ReadonlyArray<string>;
    /**
     * Where the per-step boolean lives in localStorage. Null means "derived" — the step's done
     * state is computed purely from inputs (PR state, CI rollup, etc.) and `storedValue` will be
     * undefined inside `calculate`. Non-null storage keys are namespaced under
     * `agent-storm:merge-step:<folder>:<storageKey>` so they're scoped per worktree.
     */
    storageKey: string | null;
    /** Returns true if this step counts as done. Called on every render with fresh inputs. */
    calculate: (inputs: MergeStepInputs) => boolean;
    /**
     * Optional in-progress signal — when true (and the step is not already done or failed), the
     * node renders an animated spinner. Used by `pass-ci` while CI is running and `get-approval`
     * while reviewers are still pending.
     */
    loading?: (inputs: MergeStepInputs) => boolean;
    /**
     * Optional failure signal — when true (and the step is not already done), the node renders a
     * red exclamation mark instead of the step number. Used by `get-approval` when the PR is
     * actively blocked by `CHANGES_REQUESTED`. Takes precedence over `loading` so a known failure
     * doesn't get masked by a still-spinning indicator.
     */
    failed?: (inputs: MergeStepInputs) => boolean;
    /**
     * Optional invalidation: when true, the stored boolean is cleared right before `calculate`
     * runs. Lets self-QA / self-review auto-uncheck the instant uncommitted changes appear, or the
     * moment a new commit lands past the SHA the user reviewed. Steps without a `storageKey` should
     * leave this undefined.
     */
    invalidate?: (inputs: MergeStepInputs) => boolean;
    /**
     * Click handler. Fully explicit — replaces the default toggle. A pure-toggle step writes `({},
     * {toggleStored}) => toggleStored()`; a derived "Open PR" step writes `({}, {openPr}) =>
     * openPr()`.
     */
    onClick: (inputs: MergeStepInputs, actions: MergeStepActions) => void;
    /**
     * Optional hover-revealed menu. When provided, hovering (or focusing) the step renders a
     * popover with these entries; each entry is its own discrete action so a single click can't
     * accidentally fire two side-effects at once. Self-review (code) uses this to split "mark
     * reviewed" from "launch VS Code" — clicking the step itself is a no-op while the popover is
     * visible, so power-user actions stay opt-in.
     */
    popoverActions?: ReadonlyArray<{
        /**
         * Either a static label or a function that derives the label from current inputs. The
         * dynamic form lets a single popover entry surface different verbs depending on state —
         * e.g. "Mark as reviewed" vs "Unmark as reviewed" against `storedValue`.
         */
        label: string | ((inputs: MergeStepInputs) => string);
        onClick: (inputs: MergeStepInputs, actions: MergeStepActions) => void;
    }>;
};

export const mergeStepsConfig: ReadonlyArray<MergeStepConfigValue> = [
    {
        name: 'ai-generating',
        todoLabel: 'AI generating',
        doneLabel: 'AI idle',
        storageKey: null,
        // The step "passes" whenever Claude isn't actively rendering output — the worktree
        // is between AI turns and the user can move on to QA / review. There's no historical
        // "AI ever ran" signal, so a fresh worktree where Claude has never been launched
        // also reads as done; the loading state only kicks in once Claude actually starts
        // generating.
        calculate: ({aiPaneStatus}) => aiPaneStatus !== PaneStatus.Busy,
        loading: ({aiPaneStatus}) => aiPaneStatus === PaneStatus.Busy,
        onClick: () => {},
    },
    {
        name: 'ai-self-review',
        todoLabel: 'AI self-review',
        doneLabel: 'AI self-reviewed',
        storageKey: 'ai-self-review',
        calculate: ({storedValue}) => storedValue === true,
        // Same staleness rule as Self-QA: any uncommitted change means the AI's review was
        // against a different tree state. Mask (don't clear) so the checkmark restores once the
        // working tree goes clean again. Manual click for now — wired to toggle until an
        // automated AI-review action lands.
        invalidate: ({hasUncommittedChanges}) => hasUncommittedChanges,
        onClick: (_inputs, {toggleStored}) => toggleStored(),
    },
    {
        name: 'self-qa',
        todoLabel: 'Self-QA',
        doneLabel: 'Self-QA done',
        storageKey: 'self-qa',
        calculate: ({storedValue}) => storedValue === true,
        // Any local edit means the QA attestation was made against a different tree state —
        // mask the step on this render. The underlying boolean is preserved (see the
        // `invalidate` handling in the render loop), so the step un-masks the moment the
        // working tree goes clean again rather than forcing the user to re-click.
        invalidate: ({hasUncommittedChanges}) => hasUncommittedChanges,
        // Click is intercepted by the renderer to open the popover (popoverActions is
        // non-empty). Kept non-undefined to satisfy the type.
        onClick: () => {},
        popoverActions: [
            {
                label: (inputs) =>
                    inputs.storedValue === true ? 'Unmark as completed' : 'Mark as completed',
                onClick: (_inputs, {toggleStored}) => toggleStored(),
            },
            {
                label: 'Test locally',
                onClick: (_inputs, {runTestLocally}) => runTestLocally(),
            },
        ],
    },
    {
        name: 'self-review-code',
        todoLabel: 'Self-review (code)',
        doneLabel: 'Self-reviewed (code)',
        storageKey: 'self-review-code',
        calculate: ({storedValue}) => storedValue === true,
        // Mask (not clear) when either signal says the attestation is stale:
        //   1. Uncommitted changes — review was against a tree that no longer matches HEAD.
        //   2. HEAD moved past the SHA captured at the last check — new commits to review.
        // The stored boolean is preserved; if the user commits / resets back to the reviewed
        // SHA, the checkmark re-appears instead of having been silently wiped.
        invalidate: ({hasUncommittedChanges, localCommitHash, lastReviewedSha}) => {
            if (hasUncommittedChanges) {
                return true;
            }
            // Only invalidate on SHA mismatch when both sides are known; if we don't have a
            // local SHA yet (placeholder before first sweep) keep the prior state rather than
            // flipping it spuriously.
            if (lastReviewedSha && localCommitHash && lastReviewedSha !== localCommitHash) {
                return true;
            }
            return false;
        },
        // Click is intercepted by the renderer (when `popoverActions` is non-empty) to toggle
        // the popover. This handler is unreachable but kept non-undefined to satisfy the type.
        onClick: () => {},
        popoverActions: [
            {
                label: (inputs) =>
                    inputs.storedValue === true ? 'Unmark as reviewed' : 'Mark as reviewed',
                onClick: (inputs, {toggleStored, setLastReviewedSha}) => {
                    const wasDone = inputs.storedValue === true;
                    toggleStored();
                    // Anchor the new "reviewed" state to the SHA the user actually reviewed,
                    // or clear it on un-check so a stale SHA doesn't outlive the toggle.
                    setLastReviewedSha(wasDone ? null : inputs.localCommitHash);
                },
            },
            {
                label: 'Review code in IDE',
                onClick: (_inputs, {openInVsCode: openVsCode}) => openVsCode(),
            },
            {
                label: 'Stage trivial hunks',
                onClick: (_inputs, {stageTrivialHunks: stage}) => stage(),
            },
        ],
    },
    {
        name: 'open-draft-pr',
        todoLabel: 'Open draft PR',
        doneLabel: 'Draft PR opened',
        storageKey: null,
        // Done as soon as any PR URL appears. A non-draft PR also satisfies this — the user
        // skipped the draft phase, but the step still counts as crossed.
        calculate: ({prUrl}) => !!prUrl,
        onClick: (_inputs, {embedPr}) => embedPr(),
    },
    {
        name: 'open-pr',
        todoLabel: 'Open PR',
        doneLabel: 'PR opened',
        storageKey: null,
        // Done when the PR has been promoted out of draft state. Merged PRs naturally satisfy
        // this too — a merged PR is by definition no longer draft.
        calculate: ({prUrl, prIsDraft}) => !!prUrl && !prIsDraft,
        onClick: (_inputs, {embedPr}) => embedPr(),
    },
    {
        name: 'pass-ci',
        todoLabel: 'Pass CI',
        doneLabel: 'Passing CI',
        storageKey: null,
        calculate: ({prCiPassing}) => prCiPassing === true,
        // Spin while at least one check is still running. `failed` deliberately not set —
        // a `prCiPassing: false` is already a strong unchecked-and-not-loading signal, and
        // the user wants the explicit red-exclam treatment reserved for review changes
        // requested. (Easy to extend later if we want CI failures to also flag red.)
        loading: ({prCiInProgress}) => prCiInProgress,
        failed: ({prCiPassing}) => prCiPassing === false,
        onClick: (_inputs, {embedPr}) => embedPr(),
    },
    {
        name: 'get-approval',
        todoLabel: 'Get approval',
        doneLabel: 'Reviewer approved',
        // Approval state is meaningless until a real (non-draft) PR exists — hide the step
        // entirely until `open-pr` is done.
        dependsOn: ['open-pr'],
        // Driven by the review-check CI status, not GitHub's `reviewDecision`. The user's
        // repo gates approval through a CI check that excludes bot reviewers (Claude, Copilot,
        // etc.) the user doesn't care about — passing that check means every approver the
        // user *does* care about has signed off. Merged PRs satisfy this too so the step
        // doesn't appear unchecked on a PR that already shipped.
        storageKey: null,
        calculate: ({prReviewCheckPassing, prMerged}) => prReviewCheckPassing === true || prMerged,
        // Loading covers two cases: review check is mid-flight, OR the PR is open + non-draft
        // with no active block. A review check sitting in a not-yet-passing state because the
        // human just hasn't approved is NOT a failure — it's "still waiting". Done/failed
        // precedence in the render loop strips the loading state once approval lands or a
        // real block appears.
        loading: ({prUrl, prIsDraft}) => !!prUrl && !prIsDraft,
        // Red exclam means "the author has something to do right now": a reviewer has actively
        // requested changes (`reviewDecision: CHANGES_REQUESTED`), at least one inline review
        // thread is still unresolved and not outdated, or the PR has merge conflicts against its
        // base that the author must resolve before it can land. Re-requesting a reviewer flips
        // GitHub's decision back to REVIEW_REQUIRED, so `prReviewChangesRequested` clears and the
        // step falls back to loading ("waiting for re-review") — exactly what we want.
        failed: ({prHasUnresolvedReviewComments, prReviewChangesRequested, prHasMergeConflicts}) =>
            prHasUnresolvedReviewComments || prReviewChangesRequested || prHasMergeConflicts,
        onClick: (_inputs, {embedPr}) => embedPr(),
    },
    {
        name: 'ready-to-merge',
        todoLabel: 'Ready to merge',
        doneLabel: 'Merged',
        storageKey: null,
        // Only meaningful once every prior step is done. Listing them explicitly keeps the
        // dependency wiring readable — a future reorder of the array won't silently change
        // which steps gate this one.
        dependsOn: [
            'ai-generating',
            'ai-self-review',
            'self-qa',
            'self-review-code',
            'open-draft-pr',
            'open-pr',
            'pass-ci',
            'get-approval',
        ],
        calculate: ({prMerged}) => prMerged,
        onClick: (_inputs, {embedPr}) => embedPr(),
    },
];

/**
 * Build the `MergeStepInputs` shape consumed by `calculate` / `invalidate` / `loading` / `failed`
 * for a given (folder, step) pair. Centralised so the renderer and the sidebar's
 * `isAnyMergeStepLoading` agree exactly on what each step sees — no chance for the two to drift
 * apart when a new field is added to `MergeStepInputs`.
 *
 * `optimisticStoredValue` lets the renderer overlay an in-flight optimistic toggle on top of the
 * server-reported stored value (clicked-but-not-yet-acked). Callers without that state (e.g. the
 * sidebar) pass undefined.
 */
export function buildMergeStepInputs(
    folder: FolderInfo,
    step: MergeStepConfigValue,
    optimisticStoredValue?: boolean,
): MergeStepInputs {
    const storedValue =
        step.storageKey != null
            ? (optimisticStoredValue ?? folder.mergeStepValues[step.storageKey])
            : undefined;
    const inputs: MergeStepInputs = {
        storedValue,
        folderPath: folder.path,
        hasUncommittedChanges: folder.hasUncommittedChanges,
        localCommitHash: folder.localCommitHash ?? null,
        branchCommitHash: folder.branchCommitHash ?? null,
        lastReviewedSha: folder.lastReviewedSha ?? null,
        prUrl: folder.prUrl ?? null,
        prMerged: folder.prMerged,
        prIsDraft: folder.prIsDraft,
        prCiPassing: folder.prCiPassing ?? null,
        prCiInProgress: folder.prCiInProgress,
        prReviewCheckPassing: folder.prReviewCheckPassing ?? null,
        prReviewCheckInProgress: folder.prReviewCheckInProgress,
        prApproved: folder.prApproved,
        prReviewChangesRequested: folder.prReviewChangesRequested,
        prReviewPending: folder.prReviewPending,
        prHasUnresolvedReviewComments: folder.prHasUnresolvedReviewComments,
        prHasMergeConflicts: folder.prHasMergeConflicts,
        aiPaneStatus: folder.panes.ai,
    };
    // Match the renderer: `invalidate` masks the stored value for this evaluation (not
    // cleared on disk). Self-QA / self-review-code rely on this to un-check the moment
    // uncommitted changes appear, without permanently losing the user's attestation.
    if (step.storageKey != null && step.invalidate?.(inputs)) {
        inputs.storedValue = undefined;
    }
    return inputs;
}

/**
 * Compute the effective done / failed / loading state for a step against a folder, applying the
 * renderer's done > failed > loading precedence. The trio matches exactly what the user sees on the
 * corresponding step node in the progress tracker.
 */
export function evaluateMergeStep(
    folder: FolderInfo,
    step: MergeStepConfigValue,
    optimisticStoredValue?: boolean,
): {done: boolean; failed: boolean; loading: boolean} {
    const inputs = buildMergeStepInputs(folder, step, optimisticStoredValue);
    const done = step.calculate(inputs);
    const failed = !done && (step.failed?.(inputs) ?? false);
    const loading = !done && !failed && (step.loading?.(inputs) ?? false);
    return {done, failed, loading};
}

/**
 * Map each step name to its current done state for the given folder. Used to resolve `dependsOn`
 * for visibility — a step is shown iff every dep name maps to `done: true`.
 */
function buildDoneByName(folder: FolderInfo): Record<string, boolean> {
    const out: Record<string, boolean> = {};
    for (const step of mergeStepsConfig) {
        out[step.name] = evaluateMergeStep(folder, step).done;
    }
    return out;
}

/**
 * True iff every step in `step.dependsOn` is currently done. Unknown dep names resolve to `false`
 * so a typo hides the step rather than silently passing.
 */
export function areStepDepsSatisfied(
    step: MergeStepConfigValue,
    doneByName: Readonly<Record<string, boolean>>,
): boolean {
    if (!step.dependsOn || step.dependsOn.length === 0) return true;
    return step.dependsOn.every((name) => doneByName[name] === true);
}

/**
 * True iff at least one merge-step whose dependencies are currently satisfied is rendering as
 * loading (spinner) for this folder. The sidebar uses this as the source of truth for the Working /
 * Needs-attention grouping. Deps-unmet steps don't render as loading even if their underlying
 * `loading` predicate is true, so they're skipped here for the same reason.
 */
export function isAnyMergeStepLoading(folder: FolderInfo): boolean {
    const doneByName = buildDoneByName(folder);
    return mergeStepsConfig.some((step) => {
        if (!areStepDepsSatisfied(step, doneByName)) return false;
        return evaluateMergeStep(folder, step).loading;
    });
}
