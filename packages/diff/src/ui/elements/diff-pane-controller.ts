// cspell:words unstages

import {
    GitDiffSide,
    type DiffSelection,
    type GitDiffFileContents,
    type GitDiffStatus,
    type ReviewComment,
} from '@agent-storm/common';
import {isDarkMode, localStorageClient} from '@agent-storm/core/frontend';
import {check} from '@augment-vir/assert';
import {PromiseQueue, extractErrorMessage} from '@augment-vir/common';
import {convertDuration, type AnyDuration} from 'date-vir';
import {
    allSelectValues,
    findSelected,
    nextSideValue,
    reselectValue,
    withFilesMoved,
    type SelectedFile,
} from '../../util/diff-status.js';
import {
    discardFiles,
    discardUnstaged,
    discardUnstagedPrompt,
    readDiffFile,
    readReviewComments,
    readStatus,
    stageFiles,
    toDiscardFilesPrompt,
    toHunkRequests,
    writeHunks,
    type HunkMenu,
} from './diff-pane-requests.js';
import {stageScopeLabel} from './diff-selection.js';
import {type CommentDraft} from './vir-diff-comment-composer.element.js';

/**
 * How often the pane re-reads `git status` and the open file while it's visible: fast enough that
 * an agent's edits show up while you're still looking at the pane, and slow enough that a `git
 * status` per interval is free on a local repo.
 */
const refreshInterval: AnyDuration = {
    seconds: 2,
};

/** Everything `vir-diff-pane` tracks apart from its config-backed diff settings. */
export function createDiffPaneState() {
    return {
        status: undefined as GitDiffStatus | undefined,
        statusError: undefined as string | undefined,
        selectedValue: undefined as string | undefined,
        /**
         * Files picked out with cmd/ctrl or shift click, for acting on several at once. Separate
         * from `selectedValue` on purpose: marking files leaves the open diff alone, so the user
         * can keep reading one file while collecting the set to stage.
         *
         * Empty means no multi-selection, and every row button acts on its own row.
         */
        markedValues: [] as ReadonlyArray<string>,
        /** Row a shift click measures its range from: the last row clicked without shift. */
        selectionAnchor: undefined as string | undefined,
        /** Old/new text for the selected file, or undefined while it loads. */
        diffContent: undefined as GitDiffFileContents | undefined,
        /**
         * Selection values whose oversized diff the user asked for anyway. Per file rather than a
         * pane-wide flag, and dropped on folder change, so one deliberate wait doesn't sign the
         * user up for every other huge file in the repo.
         */
        allowLargeValues: [] as ReadonlyArray<string>,
        diffError: undefined as string | undefined,
        /** Mirrors {@link isDarkMode} so the editors can be rebuilt in the other palette. */
        isDark: isDarkMode(),
        stopThemeListener: undefined as (() => void) | undefined,
        /** Index into the open file's chunks that the jump buttons move relative to. */
        activeChunkIndex: 0,
        /** How many chunks the open file's editor shows, as its code view last reported. */
        chunkCount: 0,
        chunkScroll: undefined as
            | Readonly<{
                  chunkIndex: number;
                  requestId: number;
              }>
            | undefined,
        hunkMenu: undefined as HunkMenu | undefined,
        /**
         * Review comments stored for the folder's review, polled with the status so a comment the
         * skill posted and cleared disappears here too.
         */
        reviewComments: [] as ReadonlyArray<ReviewComment>,
        commentDraft: undefined as CommentDraft | undefined,
        /**
         * Folder the live refresh timer was created for, or undefined when no timer is running.
         * Both the "pane became visible" and "user switched folders" transitions are the same event
         * to this pane — tear the timer down and re-arm it — so one field drives both, and the
         * re-arm is what gives the new interval callback a closure over the current folder.
         */
        armedFolder: undefined as string | undefined,
        refreshTimer: undefined as ReturnType<typeof setInterval> | undefined,
        /** How many status reads the pane has started, which is how each one is numbered. */
        readsStarted: 0,
        /**
         * Reads numbered below this are outdated, and their results get dropped instead of shown
         * over newer ones.
         */
        firstCurrentRead: 0,
        /** Suppresses overlapping refreshes and disables the bulk and hunk buttons mid-write. */
        busy: false,
        /**
         * Every index write goes through this one at a time: git takes `index.lock` for the
         * duration of each write, and parallel calls would lose all but one of them to a lock
         * error.
         */
        indexWriteQueue: new PromiseQueue(),
        /**
         * Whole-file stage clicks still waiting on git. Every status read is shown with these
         * already applied, so a read that lands mid-write can't put a file back.
         */
        pendingMoves: [] as ReadonlyArray<SelectedFile>,
        /**
         * File list sections the user collapsed. Kept here rather than left to each section so the
         * choice survives a section emptying out and coming back.
         */
        collapsedSides: {
            [GitDiffSide.Staged]: false,
            [GitDiffSide.Unstaged]: false,
        } as Readonly<Record<GitDiffSide, boolean>>,
        /**
         * Side whose files are being read as one stacked review, or undefined for the normal
         * one-file diff. The open file is left selected underneath, so leaving the review lands
         * back on it.
         */
        reviewSide: undefined as GitDiffSide | undefined,
    };
}

export type DiffPaneState = ReturnType<typeof createDiffPaneState>;

/** What the diff pane's controllers read and write: the element's own inputs, state, and updater. */
export type DiffPaneContext = Readonly<{
    inputs: Readonly<{
        folder: string;
        active: boolean;
        enableComments?: boolean | undefined;
        /** What this list's tab last had open, which wins over the folder's last value. */
        savedSelection?: Readonly<DiffSelection> | undefined;
    }>;
    state: Readonly<DiffPaneState>;
    updateState: (newState: Partial<DiffPaneState>) => void;
}>;

/**
 * The diff pane's reads, index writes, and navigation, in the same shape as the element's render
 * closures so async work still sees the live `state` and `inputs` after every await.
 */
export function createDiffPaneController({
    inputs,
    state,
    updateState,
    saveSelection,
}: DiffPaneContext &
    Readonly<{
        /** Stores a selection change in the list's tab. */
        saveSelection(selection: Readonly<DiffSelection>): void;
    }>) {
    /**
     * Show a status, carrying the selection and marks over to it.
     *
     * @returns The selection it settled on.
     */
    function showStatus({status, folder}: {status: Readonly<GitDiffStatus>; folder: string}) {
        const values = allSelectValues(status);
        const selectedValue = reselectValue(state.selectedValue, values);
        updateState({
            status,
            statusError: undefined,
            selectedValue,
            /**
             * A marked file that just got staged, discarded, or committed is gone from the list
             * under its old value, and keeping it marked would aim the next bulk click at a file
             * the user can no longer see.
             */
            markedValues: state.markedValues.filter((value) => values.includes(value)),
        });
        /**
         * Every path to a new selection ends here, so this one write covers them all — including
         * the poll that finds the remembered file gone and picks another.
         */
        if (selectedValue !== localStorageClient.diffFileByFolder.readFolder(folder)) {
            localStorageClient.diffFileByFolder.writeFolder({
                folder,
                value: selectedValue,
            });
        }
        if (selectedValue !== inputs.savedSelection?.file) {
            saveSelection({
                file: selectedValue,
            });
        }
        return selectedValue;
    }

    /**
     * Re-read status and, if a file is open, its contents. Both writes go through the same content
     * comparison the editor rebuild uses, so a poll that finds nothing new is inert.
     *
     * Reads overlap whenever git is slower than the poll, so a read that lands after a newer one
     * was shown, after the folder changed, or after the user opened another file is dropped rather
     * than shown over the newer state.
     */
    async function refresh() {
        const folder = inputs.folder;
        const readNumber = state.readsStarted + 1;
        updateState({
            readsStarted: readNumber,
        });
        function isOutdated() {
            return state.armedFolder !== folder || readNumber < state.firstCurrentRead;
        }
        const [
            statusRead,
            reviewComments,
        ] = await Promise.all([
            readStatus(folder),
            inputs.enableComments ? readReviewComments(folder) : undefined,
        ]);
        if (isOutdated()) {
            return;
        }
        updateState({
            firstCurrentRead: readNumber,
            ...(reviewComments
                ? {
                      reviewComments,
                  }
                : {}),
        });
        if ('error' in statusRead) {
            updateState({
                statusError: statusRead.error,
            });
            return;
        }
        const shownStatus = withFilesMoved(statusRead.status, state.pendingMoves);
        const selectedValue = showStatus({
            status: shownStatus,
            folder,
        });

        const nextSelected = findSelected(shownStatus, selectedValue);
        if (!nextSelected) {
            updateState({
                diffContent: undefined,
            });
            return;
        }
        const diffRead = await readDiffFile({
            folder,
            selected: nextSelected,
            allowLarge: state.allowLargeValues.includes(selectedValue ?? ''),
        });
        if (isOutdated() || state.selectedValue !== selectedValue) {
            return;
        }
        updateState(
            'error' in diffRead
                ? {
                      diffError: diffRead.error,
                  }
                : {
                      diffContent: diffRead.diffContent,
                      diffError: undefined,
                  },
        );
    }

    /** Starts, restarts, or stops the refresh poll to match the pane's visibility and folder. */
    function syncRefreshTimer() {
        if (inputs.active && state.armedFolder !== inputs.folder) {
            if (state.refreshTimer) {
                clearInterval(state.refreshTimer);
            }
            updateState({
                armedFolder: inputs.folder,
                refreshTimer: setInterval(
                    () => {
                        if (!state.busy) {
                            /**
                             * Not awaited: the timer can't wait on a callback, and overlapping
                             * reads are expected and sorted out by `refresh` itself.
                             */
                            void refresh();
                        }
                    },
                    convertDuration(refreshInterval, {
                        milliseconds: true,
                    }).milliseconds,
                ),
                /**
                 * The refresh below resolves this against the folder's real file list, so a
                 * remembered file that is gone falls back to the first one there.
                 */
                selectedValue:
                    inputs.savedSelection?.file ||
                    localStorageClient.diffFileByFolder.readFolder(inputs.folder),
                reviewSide:
                    (inputs.savedSelection?.reviewSide ??
                        localStorageClient.diffReviewSideByFolder.readFolder(inputs.folder) ??
                        GitDiffSide.Unstaged) ||
                    undefined,
                /** A different folder's file list and diff must not linger through the reload. */
                ...(state.armedFolder == undefined
                    ? {}
                    : {
                          status: undefined,
                          diffContent: undefined,
                          allowLargeValues: [],
                          markedValues: [],
                          selectionAnchor: undefined,
                          reviewComments: [],
                          commentDraft: undefined,
                      }),
            });
            /** Render can't await; the read updates state when it lands. */
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
    }

    /**
     * Opt this one file out of the size guard and re-read it. The refresh loop passes `allowLarge`
     * for anything in this list, so the diff also survives the next poll.
     */
    async function showLargeDiffAnyway() {
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
        await refresh();
    }

    async function selectFile(value: string) {
        /**
         * Re-clicking the open file would otherwise clear its content and re-read it, which
         * remounts the editor and throws away the scroll position the user was reading at.
         */
        if (value === state.selectedValue) {
            /** Leaving the review is still the point of the click when it's already open. */
            setReviewSide(undefined);
            return;
        }
        updateState({
            selectedValue: value,
            diffContent: undefined,
            diffError: undefined,
            activeChunkIndex: 0,
        });
        setReviewSide(undefined);
        await refresh();
    }

    /**
     * A row click, with the modifier conventions of any other file list: plain opens the file,
     * cmd/ctrl adds or removes one file from the marked set, shift marks everything between the
     * anchor and this row. Only the plain click opens a diff — the whole point of marking files is
     * to line up an action without losing the file being read.
     */
    async function onRowClick({
        value,
        isRange,
        isToggle,
    }: Readonly<{value: string; isRange: boolean; isToggle: boolean}>) {
        if (isRange) {
            const values = allSelectValues(state.status);
            const clickedIndex = values.indexOf(value);
            if (clickedIndex < 0) {
                return;
            }
            const anchorIndex = values.indexOf(state.selectionAnchor ?? state.selectedValue ?? '');
            /**
             * Shift dragging out a range leaves the anchor where it was, so widening and narrowing
             * the range walks from the same end each time.
             */
            const from = anchorIndex < 0 ? clickedIndex : Math.min(anchorIndex, clickedIndex);
            const to = anchorIndex < 0 ? clickedIndex : Math.max(anchorIndex, clickedIndex);
            /** Shift click also extends the document's text selection, across whole rows. */
            window.getSelection()?.removeAllRanges();
            updateState({
                markedValues: values.slice(from, to + 1),
            });
        } else if (isToggle) {
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
            await selectFile(value);
        }
    }

    /**
     * Queue an index write, then re-read once the queue drains so the pane reflects every write
     * without waiting on the poll. The re-read is queued too, so a write clicked during it waits
     * rather than racing git's own status refresh for the lock.
     */
    async function runIndexWrite(write: () => Promise<void>) {
        updateState({
            busy: true,
        });
        try {
            await state.indexWriteQueue.add(write);
        } catch (error: unknown) {
            updateState({
                diffError: extractErrorMessage(error),
            });
        }
        if (!state.indexWriteQueue.size) {
            await state.indexWriteQueue.add(refresh).catch(() => undefined);
        }
        updateState({
            busy: state.indexWriteQueue.size > 0,
        });
    }

    /**
     * Each file moves in the direction its own side implies, so a marked set spanning both sides
     * stages the unstaged half and unstages the staged half in one click.
     *
     * Shown as moved immediately. A failed write drops the move, and the re-read after it puts the
     * file back.
     */
    async function onStageWholeFiles(targets: ReadonlyArray<SelectedFile>) {
        updateState({
            pendingMoves: [
                ...state.pendingMoves,
                ...targets,
            ],
        });
        if (state.status) {
            const previousValue = state.selectedValue;
            const selectedValue = showStatus({
                status: withFilesMoved(state.status, targets),
                folder: inputs.folder,
            });
            if (selectedValue !== previousValue) {
                updateState({
                    diffContent: undefined,
                    diffError: undefined,
                    activeChunkIndex: 0,
                });
            }
        }
        await runIndexWrite(async () => {
            try {
                await stageFiles({
                    folder: inputs.folder,
                    targets,
                });
            } finally {
                updateState({
                    pendingMoves: state.pendingMoves.filter((move) => !targets.includes(move)),
                });
            }
        });
    }

    /**
     * Moved before the write, whose own refresh then carries this selection forward. Reading the
     * current status first is what makes the next file findable — a moment later the file being
     * staged is gone from this side.
     */
    async function onStageSelectedFile() {
        const selected = findSelected(state.status, state.selectedValue);
        if (!selected) {
            return;
        }
        const nextValue = nextSideValue(state.status, selected);
        if (nextValue) {
            updateState({
                selectedValue: nextValue,
                diffContent: undefined,
                diffError: undefined,
                activeChunkIndex: 0,
            });
        }
        await onStageWholeFiles([
            selected,
        ]);
    }

    /** Confirmed for the same reason {@link onDiscardFiles} is, and over more files. */
    async function onDiscardUnstaged() {
        if (!window.confirm(discardUnstagedPrompt)) {
            return;
        }
        await runIndexWrite(async () => {
            await discardUnstaged(inputs.folder);
        });
    }

    /**
     * Confirmed, because unlike everything else in this pane it can't be undone from git.
     *
     * Paths are deduplicated: discarding throws away both halves of a file, so a file marked on
     * both sides is one discard, not two.
     */
    async function onDiscardFiles(targets: ReadonlyArray<SelectedFile>) {
        const paths = Array.from(new Set(targets.map((target) => target.file.path)));
        if (!check.isLengthAtLeast(paths, 1) || !window.confirm(toDiscardFilesPrompt(paths))) {
            return;
        }
        await runIndexWrite(async () => {
            await discardFiles({
                folder: inputs.folder,
                paths,
            });
        });
    }

    async function onStageChunks(menu: HunkMenu) {
        const requests = toHunkRequests({
            menu,
            folder: inputs.folder,
        });
        if (!requests.length) {
            return;
        }
        await runIndexWrite(async () => {
            await writeHunks({
                requests,
                shouldDiscard: false,
            });
            /** Landing back on the first chunk avoids pointing at a chunk that just moved. */
            updateState({
                activeChunkIndex: 0,
            });
        });
    }

    /** Confirmed, because unlike staging this throws the change away for good. */
    async function onUndoChunks(menu: HunkMenu) {
        const requests = toHunkRequests({
            menu,
            folder: inputs.folder,
        });
        const scope = stageScopeLabel(menu.selections);
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
        await runIndexWrite(async () => {
            await writeHunks({
                requests,
                shouldDiscard: true,
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

    function stepChunk(delta: number) {
        if (!state.chunkCount) {
            return;
        }
        const chunkIndex = Math.min(
            state.chunkCount - 1,
            Math.max(0, state.activeChunkIndex + delta),
        );
        updateState({
            activeChunkIndex: chunkIndex,
            chunkScroll: {
                chunkIndex,
                requestId: (state.chunkScroll?.requestId ?? 0) + 1,
            },
        });
    }

    async function stepFile(delta: number) {
        const values = allSelectValues(state.status);
        const current = state.selectedValue ? values.indexOf(state.selectedValue) : -1;
        const next = values[Math.min(values.length - 1, Math.max(0, current + delta))];
        if (next && next !== state.selectedValue) {
            await selectFile(next);
        }
    }

    function setReviewSide(side: GitDiffSide | undefined) {
        updateState({
            reviewSide: side,
        });
        localStorageClient.diffReviewSideByFolder.writeFolder({
            folder: inputs.folder,
            value: side ?? false,
        });
        saveSelection({
            reviewSide: side ?? false,
        });
    }

    function toggleReview(side: GitDiffSide) {
        setReviewSide(state.reviewSide === side ? undefined : side);
    }

    return {
        refresh,
        syncRefreshTimer,
        showLargeDiffAnyway,
        selectFile,
        onRowClick,
        runIndexWrite,
        onStageWholeFiles,
        onStageSelectedFile,
        onDiscardUnstaged,
        onDiscardFiles,
        onStageChunks,
        onUndoChunks,
        closeHunkMenu,
        stepChunk,
        stepFile,
        setReviewSide,
        toggleReview,
    };
}
