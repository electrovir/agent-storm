import {type PluginServerHost} from '@agent-storm/core/server';
import {assertWrap} from '@augment-vir/assert';
import {createCuid2, extractErrorMessage, log, wait, wrapInTry} from '@augment-vir/common';
import {readFileIfExists} from '@augment-vir/node';
import {writeFileAtomically} from 'agent-storm-util';
import {type AnyDuration, convertDuration, getNowInIsoString} from 'date-vir';
import {createHash} from 'node:crypto';
import {mkdir, rm, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {defineShape, enumShape, nullableShape, parseJsonWithShape} from 'object-shape-tester';
import {type Thread, ThreadStatus} from '../build-api.js';
import {type ModelDefault} from '../util/model-default-settings.js';
import {updateFixRequestDigest} from './fix-requests.js';
import {
    carryPatchForward,
    findScratchNotesDir,
    resetScratchCopy,
    writeScratchPatch,
} from './self-improvement-scratch.js';

/** Copied beside the bundle by the plugin build, so an edit reaches the next turn without a restart. */
const instructionsPath = resolve(import.meta.dirname, 'self-improvement-instructions.md');

/** How long the user must be away before a run starts. */
const awayBeforeRun = {
    hours: 3,
} as const satisfies AnyDuration;
const passInterval = {
    minutes: 1,
} as const satisfies AnyDuration;
/** A turn running longer than this is stopped, and the AI is told to move on. */
const maxTurnDuration = {
    minutes: 45,
} as const satisfies AnyDuration;
/**
 * A message takes a moment to start its turn, so a thread still idle this soon after one hasn't
 * finished it yet.
 */
const turnStartGrace = {
    minutes: 2,
} as const satisfies AnyDuration;
const turnSettleTimeout = {
    seconds: 60,
} as const satisfies AnyDuration;

const runBudgetUsd = 200;
/** Spend is only read once a pass, so a run stops this far below its budget. */
const budgetMarginUsd = 15;
/** Provider failures in a row before a run stops. */
const maxFailedTurns = 3;
/** Turns in a row without progress before the AI is told to switch areas; twice this stops the run. */
const maxStalledTurns = 3;
/** Turns in a row one problem may go without changing the code before the AI is told to abandon it. */
const maxStalledTurnsPerProblem = 2;
/**
 * Turns one problem may take even while its code keeps changing, which catches edits going in
 * circles.
 */
const maxTurnsPerProblem = 8;
/** Passes in a row whose spend had unpriced tokens before a run stops, since its budget can't hold. */
const maxUnpricedPasses = 5;

enum RunPhase {
    /** Taking turns while the user is away. */
    Working = 'working',
    /** Stopped before the user came back, such as at its budget. Still owes the user a summary. */
    Halted = 'halted',
    /** Summarized for the user, whose approval the thread now waits on. */
    WrappedUp = 'wrappedUp',
}

/** Whether the user is away during each phase, so the thread's requests are declined unseen. */
const isUnattendedPhase: Readonly<Record<RunPhase, boolean>> = {
    [RunPhase.Working]: true,
    [RunPhase.Halted]: true,
    [RunPhase.WrappedUp]: false,
};

const isMidTurn: Readonly<Record<ThreadStatus, boolean>> = {
    [ThreadStatus.Idle]: false,
    [ThreadStatus.Running]: true,
    [ThreadStatus.NeedsApproval]: true,
    [ThreadStatus.Failed]: false,
};

const runShape = defineShape({
    /** Epoch milliseconds. */
    startedAt: 0,
    /** The scratch copy's commit of the live checkout, which the run's changes are a diff against. */
    baselineCommit: '',
    phase: enumShape(RunPhase),
    /** Epoch milliseconds of the last message the thread was sent. */
    promptSentAt: 0,
    failedTurnCount: 0,
    /** Turns in a row that changed neither the code nor the journal. */
    stalledTurnCount: 0,
    progressFingerprint: '',
    /** Of the code changes alone, without the journal. */
    codeFingerprint: '',
    /** The journal's `Current problem:` line at the end of the last turn. */
    currentProblem: '',
    currentProblemTurnCount: 0,
    /** Turns in a row on the current problem that left the code unchanged. */
    currentProblemStalledTurnCount: 0,
});

type Run = typeof runShape.runtimeType;

const stateShape = defineShape({
    /** Empty before the first run. Kept across runs, so each run continues the same thread. */
    threadId: '',
    run: nullableShape(runShape),
});

type State = typeof stateShape.runtimeType;

/** What the self-improvement loop needs from Build's server. */
export type SelfImprovementParams = Readonly<{
    /** Holds the scratch copy, the loop's state, and the proposals made to the user. */
    stateDir: string;
    host: Pick<
        PluginServerHost,
        'findAppCheckoutPath' | 'loadSettings' | 'readLastUserInputAt' | 'listenToUserInput'
    >;
    /** Undefined when the thread is gone or archived. */
    findThread(threadId: string): Promise<Readonly<Thread> | undefined>;
    /** For a thread in `folder`. */
    readModelDefault(folder: string): Promise<Readonly<ModelDefault>>;
    startThread(
        params: Readonly<{
            threadId: string;
            repoPath: string;
            cwd: string;
            text: string;
            modelDefault: Readonly<ModelDefault>;
        }>,
    ): Promise<void>;
    switchModel(
        params: Readonly<{threadId: string; modelDefault: Readonly<ModelDefault>}>,
    ): Promise<void>;
    sendMessage(params: Readonly<{threadId: string; text: string}>): Promise<void>;
    addNotice(params: Readonly<{threadId: string; text: string}>): Promise<void>;
    interrupt(threadId: string): Promise<void>;
    /** Undefined while the Usage plugin isn't running. */
    readThreadCost(
        params: Readonly<{threadId: string; since: number}>,
    ): Promise<Readonly<{costUsd: number; hasUnpricedTokens: boolean}> | undefined>;
}>;

function toMilliseconds(duration: AnyDuration) {
    return convertDuration(duration, {
        milliseconds: true,
    }).milliseconds;
}

/**
 * Runs agent-storm's self-improvement loop: while the user has been away long enough, an AI thread
 * works on a scratch copy of the checkout the app runs from, one problem per turn, within a budget.
 * When the user is back, the thread stops and proposes its changes, and only copies them into the
 * live checkout once the user approves in the thread.
 */
export async function startSelfImprovement(params: SelfImprovementParams) {
    const statePath = join(params.stateDir, 'state.json');
    const scratchPath = join(params.stateDir, 'agent-storm');
    const journalPath = join(findScratchNotesDir(scratchPath), 'self-improvement-journal.md');
    const progressPatchPath = join(params.stateDir, 'progress.patch');
    const startedAt = Date.now();
    const stateContents = await readFileIfExists(statePath);
    const current: {state: State; unpricedPassCount: number; isStopped: boolean} = {
        state: (stateContents &&
            wrapInTry(() => parseJsonWithShape(stateContents, stateShape), {
                fallbackValue: undefined,
            })) || {
            threadId: '',
            run: undefined,
        },
        unpricedPassCount: 0,
        isStopped: false,
    };

    async function saveState(state: State) {
        current.state = state;
        await writeFileAtomically({
            path: statePath,
            contents: JSON.stringify(state, undefined, 4),
        });
    }

    async function updateRun(update: Readonly<Partial<Run>>) {
        if (current.state.run) {
            await saveState({
                ...current.state,
                run: {
                    ...current.state.run,
                    ...update,
                },
            });
        }
    }

    async function isEligible() {
        const settings = await params.host.loadSettings();
        return (
            !!params.host.findAppCheckoutPath() &&
            !!settings.enableDebugLogs &&
            !settings.disableSelfImprovement
        );
    }

    async function isUserBackSince(time: number) {
        return ((await params.host.readLastUserInputAt()) ?? 0) > time;
    }

    async function sendPrompt({threadId, text}: Readonly<{threadId: string; text: string}>) {
        await updateRun({
            promptSentAt: Date.now(),
        });
        await params.sendMessage({
            threadId,
            text,
        });
    }

    /**
     * Returns once the thread's turn ended, or once waiting for that times out. The return type
     * annotation is required by the recursion.
     */
    async function waitForTurnEnd(threadId: string, deadline: number): Promise<void> {
        const thread = await params.findThread(threadId);
        if (!thread || !isMidTurn[thread.status] || Date.now() > deadline) {
            return;
        }
        await wait({
            seconds: 2,
        });
        await waitForTurnEnd(threadId, deadline);
    }

    async function interruptTurn(threadId: string) {
        await params.interrupt(threadId);
        await waitForTurnEnd(threadId, Date.now() + toMilliseconds(turnSettleTimeout));
    }

    async function halt(thread: Readonly<Thread>, reason: string) {
        await updateRun({
            phase: RunPhase.Halted,
        });
        if (isMidTurn[thread.status]) {
            await interruptTurn(thread.id);
        }
        await params.addNotice({
            threadId: thread.id,
            text: `Self-improvement stopped early: ${reason} Its changes are summarized for you once you're back.`,
        });
    }

    async function wrapUp() {
        const run = assertWrap.isDefined(current.state.run);
        const checkoutPath = assertWrap.isDefined(params.host.findAppCheckoutPath());
        const threadId = current.state.threadId;
        await updateRun({
            phase: RunPhase.WrappedUp,
        });
        const thread = await params.findThread(threadId);
        if (!thread) {
            return;
        }
        if (isMidTurn[thread.status]) {
            await interruptTurn(threadId);
        }
        const patchPath = join(
            params.stateDir,
            'proposals',
            `${getNowInIsoString().replaceAll(':', '-')}.patch`,
        );
        await mkdir(join(params.stateDir, 'proposals'), {
            recursive: true,
        });
        const hasChanges = await writeScratchPatch({
            scratchPath,
            baselineCommit: run.baselineCommit,
            patchPath,
        });
        if (!hasChanges) {
            await rm(patchPath, {
                force: true,
            });
            await params.addNotice({
                threadId,
                text: 'Self-improvement stopped because you came back. It had no changes to propose.',
            });
            return;
        }
        await params.sendMessage({
            threadId,
            text: [
                'Agent-storm self-improvement: the user is back, so this run is over. Stop investigating and change nothing else.',
                `Reply with a very high level summary of this run's changes, which are all in ${patchPath}: a few short bullets grouped by goal (speed, token use, bugs, cleanup, GitHub rate limits), with no file-by-file detail. Then propose copying them into the live checkout at ${checkoutPath}.`,
                `Do not touch the live checkout until the user approves here. Once they do, run \`git -C ${checkoutPath} apply ${patchPath}\` and report the result. If it fails, say why and change nothing. If they decline, do nothing.`,
                `If the user asks for changes first, make them in this scratch copy, then rewrite the patch with \`git add --all && git diff --cached --binary ${run.baselineCommit} --output=${patchPath}\` before applying it.`,
            ].join('\n\n'),
        });
    }

    async function startRun(checkoutPath: string) {
        const decidedAt = Date.now();
        const previousRun = current.state.run;
        const carriedPatchPath = join(params.stateDir, 'carried.patch');
        await rm(carriedPatchPath, {
            force: true,
        });
        const hasCarriedChanges =
            !!previousRun &&
            (await writeScratchPatch({
                scratchPath,
                baselineCommit: previousRun.baselineCommit,
                patchPath: carriedPatchPath,
            }).catch(() => false));
        const journal = (await readFileIfExists(journalPath)) || '';
        const baselineCommit = await resetScratchCopy({
            checkoutPath,
            scratchPath,
        });
        await writeFile(journalPath, journal);
        const carryNote = hasCarriedChanges
            ? await carryPatchForward({
                  scratchPath,
                  patchPath: carriedPatchPath,
                  unappliedPatchPath: join(params.stateDir, `unapplied-${decidedAt}.patch`),
              })
            : undefined;
        try {
            await updateFixRequestDigest({
                checkoutPath,
                ledgerPath: join(params.stateDir, 'fix-requests.json'),
                digestPath: join(
                    findScratchNotesDir(scratchPath),
                    'self-improvement-fix-requests.md',
                ),
            });
        } catch (error) {
            log.warning(`Reading the user's fix requests failed: ${extractErrorMessage(error)}`);
        }
        if ((await isUserBackSince(decidedAt)) || !(await isEligible()) || current.isStopped) {
            /** Carried changes now sit on the new baseline, so the next run must diff against it. */
            await saveState({
                ...current.state,
                run: previousRun
                    ? {
                          ...previousRun,
                          baselineCommit,
                      }
                    : undefined,
            });
            return;
        }
        const modelDefault = await params.readModelDefault(checkoutPath);
        const existing = current.state.threadId
            ? await params.findThread(current.state.threadId)
            : undefined;
        const threadId = existing?.id || createCuid2();
        const text = [
            `Agent-storm self-improvement: a new run started on a fresh copy of the live checkout. Follow ${instructionsPath}, rereading it now since it may have changed.`,
            carryNote,
        ]
            .filter(Boolean)
            .join(' ');
        await saveState({
            threadId,
            run: {
                startedAt: Date.now(),
                baselineCommit,
                phase: RunPhase.Working,
                promptSentAt: Date.now(),
                failedTurnCount: 0,
                stalledTurnCount: 0,
                progressFingerprint: '',
                codeFingerprint: '',
                currentProblem: '',
                currentProblemTurnCount: 0,
                currentProblemStalledTurnCount: 0,
            },
        });
        if (existing) {
            if (isMidTurn[existing.status]) {
                await interruptTurn(threadId);
            }
            await params.switchModel({
                threadId,
                modelDefault,
            });
            await params.sendMessage({
                threadId,
                text,
            });
        } else {
            await params.startThread({
                threadId,
                repoPath: checkoutPath,
                cwd: scratchPath,
                text,
                modelDefault,
            });
        }
    }

    async function moveOn({thread, run}: Readonly<{thread: Readonly<Thread>; run: Run}>) {
        const hasChanges = await writeScratchPatch({
            scratchPath,
            baselineCommit: run.baselineCommit,
            patchPath: progressPatchPath,
        });
        const journal = (await readFileIfExists(journalPath)) || '';
        const codeFingerprint = createHash('sha256')
            .update(hasChanges ? (await readFileIfExists(progressPatchPath)) || '' : '')
            .digest('hex');
        const fingerprint = createHash('sha256')
            .update(codeFingerprint)
            .update(journal)
            .digest('hex');
        const problem = /^Current problem:(.*)$/im.exec(journal)?.[1]?.trim() || '';
        const stalledTurnCount =
            fingerprint === run.progressFingerprint ? run.stalledTurnCount + 1 : 0;
        const isSameProblem = !!problem && problem === run.currentProblem;
        const currentProblemTurnCount = isSameProblem ? run.currentProblemTurnCount + 1 : 1;
        const currentProblemStalledTurnCount =
            isSameProblem && codeFingerprint === run.codeFingerprint
                ? run.currentProblemStalledTurnCount + 1
                : 0;
        await updateRun({
            failedTurnCount: 0,
            progressFingerprint: fingerprint,
            codeFingerprint,
            stalledTurnCount,
            currentProblem: problem,
            currentProblemTurnCount,
            currentProblemStalledTurnCount,
        });
        const abandonReason =
            currentProblemStalledTurnCount >= maxStalledTurnsPerProblem
                ? `went ${currentProblemStalledTurnCount} turns without a code change`
                : currentProblemTurnCount > maxTurnsPerProblem
                  ? `has taken ${currentProblemTurnCount} turns`
                  : undefined;
        if (stalledTurnCount >= maxStalledTurns * 2) {
            await halt(thread, 'it stopped making progress.');
            return;
        }
        await sendPrompt({
            threadId: thread.id,
            text: abandonReason
                ? `Agent-storm self-improvement: "${problem}" ${abandonReason}. Abandon it now: undo its unfinished edits, log it under Abandoned in the journal, and take a different problem.`
                : stalledTurnCount >= maxStalledTurns
                  ? `Agent-storm self-improvement: the last ${stalledTurnCount} turns changed neither the code nor the journal. Switch to a different area of agent-storm and a different kind of problem.`
                  : `Agent-storm self-improvement: next turn. Take the next problem, per ${instructionsPath}.`,
        });
    }

    /** What a pass does with a working run, by its thread's status. */
    const turnHandlers: Readonly<
        Record<
            ThreadStatus,
            (params: Readonly<{thread: Readonly<Thread>; run: Run}>) => Promise<void>
        >
    > = {
        async [ThreadStatus.Idle]({thread, run}) {
            if (Date.now() - run.promptSentAt >= toMilliseconds(turnStartGrace)) {
                await moveOn({
                    thread,
                    run,
                });
            }
        },
        async [ThreadStatus.Failed]({thread, run}) {
            if (Date.now() - run.promptSentAt < toMilliseconds(turnStartGrace)) {
                return;
            }
            const failedTurnCount = run.failedTurnCount + 1;
            await updateRun({
                failedTurnCount,
            });
            if (failedTurnCount >= maxFailedTurns) {
                await halt(thread, `its AI failed ${failedTurnCount} times in a row.`);
                return;
            }
            await sendPrompt({
                threadId: thread.id,
                text: `Agent-storm self-improvement: your last turn failed. Continue, per ${instructionsPath}.`,
            });
        },
        async [ThreadStatus.Running]({thread, run}) {
            if (Date.now() - run.promptSentAt < toMilliseconds(maxTurnDuration)) {
                return;
            }
            await interruptTurn(thread.id);
            const problemName = run.currentProblem ? `"${run.currentProblem}"` : 'that problem';
            await sendPrompt({
                threadId: thread.id,
                text: `Agent-storm self-improvement: your last turn ran too long and was stopped. Abandon ${problemName}: undo its unfinished edits, log it under Abandoned in the journal, and take a different problem.`,
            });
        },
        async [ThreadStatus.NeedsApproval](handlerParams) {
            await turnHandlers[ThreadStatus.Running](handlerParams);
        },
    };

    async function continueRun(run: Run) {
        const thread = await params.findThread(current.state.threadId);
        if (!thread) {
            /** The user archived the thread, which ends its run. */
            await updateRun({
                phase: RunPhase.WrappedUp,
            });
            return;
        } else if (!(await isEligible())) {
            await halt(thread, 'self-improvement or debug logging was turned off.');
            return;
        }
        const cost = await params.readThreadCost({
            threadId: thread.id,
            since: run.startedAt,
        });
        current.unpricedPassCount = cost?.hasUnpricedTokens ? current.unpricedPassCount + 1 : 0;
        const haltReason = cost
            ? current.unpricedPassCount >= maxUnpricedPasses
                ? 'its model has no known price, so its spend could not be capped.'
                : cost.costUsd >= runBudgetUsd - budgetMarginUsd
                  ? `it reached its $${runBudgetUsd} budget.`
                  : undefined
            : 'the Usage plugin is off, so its spend could not be capped.';
        if (haltReason) {
            await halt(thread, haltReason);
            return;
        }
        await turnHandlers[thread.status]({
            thread,
            run,
        });
    }

    async function startRunIfAway() {
        const checkoutPath = params.host.findAppCheckoutPath();
        const awaySince = (await params.host.readLastUserInputAt()) ?? startedAt;
        if (
            checkoutPath &&
            Date.now() - awaySince >= toMilliseconds(awayBeforeRun) &&
            (await isEligible())
        ) {
            await startRun(checkoutPath);
        }
    }

    const phaseHandlers: Readonly<Record<RunPhase, (run: Run) => Promise<void>>> = {
        async [RunPhase.Working](run) {
            await ((await isUserBackSince(run.startedAt)) ? wrapUp() : continueRun(run));
        },
        async [RunPhase.Halted](run) {
            if (await isUserBackSince(run.startedAt)) {
                await wrapUp();
            }
        },
        async [RunPhase.WrappedUp]() {
            await startRunIfAway();
        },
    };

    const passes: {chain: Promise<void>; isQueued: boolean} = {
        chain: Promise.resolve(),
        isQueued: false,
    };

    /** Passes run one at a time, and a pass asked for while one is waiting is the same pass. */
    function schedulePass() {
        if (passes.isQueued || current.isStopped) {
            return;
        }
        passes.isQueued = true;
        passes.chain = passes.chain.then(async () => {
            passes.isQueued = false;
            if (current.isStopped) {
                return;
            }
            try {
                const run = current.state.run;
                await (run ? phaseHandlers[run.phase](run) : startRunIfAway());
            } catch (error) {
                log.warning(`A self-improvement pass failed: ${extractErrorMessage(error)}`);
            }
        });
    }

    const passTimer = setInterval(schedulePass, toMilliseconds(passInterval));
    const stopListening = params.host.listenToUserInput(schedulePass);
    schedulePass();

    return {
        /** Whether the thread is self-improvement's while the user is away, so nobody can answer it. */
        isUnattended(threadId: string) {
            return (
                current.state.threadId === threadId &&
                !!current.state.run &&
                isUnattendedPhase[current.state.run.phase]
            );
        },
        /** Waits for a pass in progress, so a restarted plugin never runs two at once. */
        async stop() {
            current.isStopped = true;
            clearInterval(passTimer);
            stopListening();
            await passes.chain;
        },
    };
}
