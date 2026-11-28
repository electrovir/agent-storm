import {
    BotAiEffort,
    BotAiProvider,
    BotAiRunStatus,
    type BotRun,
    defineBot,
    type EndedBotAiRunStatus,
} from '@agent-storm/bot';
import {extractErrorMessage, log, wrapInTry} from '@augment-vir/common';
import {readFileIfExists} from '@augment-vir/node';
import {userDataDir, writeFileAtomically} from 'agent-storm-util';
import {convertDuration, getNowInIsoString} from 'date-vir';
import {createHash} from 'node:crypto';
import {mkdir, rm, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {defineShape, enumShape, nullableShape, parseJsonWithShape} from 'object-shape-tester';
import {updateFixRequestDigest} from './fix-requests.js';
import {
    carryPatchForward,
    findScratchNotesDir,
    resetScratchCopy,
    writeScratchPatch,
} from './self-improvement-scratch.js';

/** Read from the live checkout, so an edit reaches the next turn. */
const instructionsPath = resolve(import.meta.dirname, 'self-improvement-instructions.md');

/** Holds the scratch copy, the bot's state, and the proposals made to the user. */
const stateDir = join(userDataDir, 'self-improvement');
const statePath = join(stateDir, 'state.json');
const scratchPath = join(stateDir, 'agent-storm');
const journalPath = join(findScratchNotesDir(scratchPath), 'self-improvement-journal.md');
const progressPatchPath = join(stateDir, 'progress.patch');

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

enum RunPhase {
    /** Taking turns while the user is away. */
    Working = 'working',
    /** Stopped before the user came back, such as at its spend limit. Still owes the user a summary. */
    Halted = 'halted',
    /** Its changes were handed to the user in a sidebar thread, or it had none. */
    WrappedUp = 'wrappedUp',
}

const runShape = defineShape({
    /** Epoch milliseconds. */
    startedAt: 0,
    /** The scratch copy's commit of the live checkout, which the run's changes are a diff against. */
    baselineCommit: '',
    phase: enumShape(RunPhase),
    /** Set from when a turn is handed to the AI until its outcome is looked at. */
    isTurnPending: false,
    /** What the next turn is told. */
    nextPrompt: '',
    /** Why a halted run stopped, for the summary. */
    haltReason: '',
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
    run: nullableShape(runShape),
});

async function readRun() {
    const contents = await readFileIfExists(statePath);
    return contents
        ? wrapInTry(() => parseJsonWithShape(contents, stateShape).run || undefined, {
              fallbackValue: undefined,
          })
        : undefined;
}

async function saveRun(run: Readonly<Run>) {
    await writeFileAtomically({
        path: statePath,
        contents: JSON.stringify(
            {
                run,
            },
            undefined,
            4,
        ),
    });
    return run;
}

function halt({run, reason}: Readonly<{run: Readonly<Run>; reason: string}>) {
    return {
        ...run,
        phase: RunPhase.Halted,
        haltReason: reason,
    };
}

/** Compares the scratch copy and journal with the end of the last turn, and picks the next prompt. */
async function moveOn(run: Readonly<Run>) {
    const hasChanges = await writeScratchPatch({
        scratchPath,
        baselineCommit: run.baselineCommit,
        patchPath: progressPatchPath,
    });
    const journal = (await readFileIfExists(journalPath)) || '';
    const codeFingerprint = createHash('sha256')
        .update(hasChanges ? (await readFileIfExists(progressPatchPath)) || '' : '')
        .digest('hex');
    const fingerprint = createHash('sha256').update(codeFingerprint).update(journal).digest('hex');
    const problem = /^Current problem:(.*)$/im.exec(journal)?.[1]?.trim() || '';
    const stalledTurnCount = fingerprint === run.progressFingerprint ? run.stalledTurnCount + 1 : 0;
    const isSameProblem = !!problem && problem === run.currentProblem;
    const currentProblemTurnCount = isSameProblem ? run.currentProblemTurnCount + 1 : 1;
    const currentProblemStalledTurnCount =
        isSameProblem && codeFingerprint === run.codeFingerprint
            ? run.currentProblemStalledTurnCount + 1
            : 0;
    const updated = {
        ...run,
        failedTurnCount: 0,
        progressFingerprint: fingerprint,
        codeFingerprint,
        stalledTurnCount,
        currentProblem: problem,
        currentProblemTurnCount,
        currentProblemStalledTurnCount,
    };
    if (stalledTurnCount >= maxStalledTurns * 2) {
        return halt({
            run: updated,
            reason: 'it stopped making progress.',
        });
    }
    const abandonReason =
        currentProblemStalledTurnCount >= maxStalledTurnsPerProblem
            ? `went ${currentProblemStalledTurnCount} turns without a code change`
            : currentProblemTurnCount > maxTurnsPerProblem
              ? `has taken ${currentProblemTurnCount} turns`
              : undefined;
    return {
        ...updated,
        nextPrompt: abandonReason
            ? `Agent Storm self-improvement: "${problem}" ${abandonReason}. Abandon it now: undo its unfinished edits, log it under Abandoned in the journal, and take a different problem, per ${instructionsPath}.`
            : stalledTurnCount >= maxStalledTurns
              ? `Agent Storm self-improvement: the last ${stalledTurnCount} turns changed neither the code nor the journal. Switch to a different area of agent-storm and a different kind of problem, per ${instructionsPath}.`
              : `Agent Storm self-improvement: next turn. Take the next problem, per ${instructionsPath}.`,
    };
}

/**
 * What the last turn's outcome means for the run. A turn whose outcome is unknown, such as the last
 * one of a bot run, which no follow-up pass sees, counts as finished.
 */
const turnSettlers: Readonly<
    Record<EndedBotAiRunStatus, (run: Readonly<Run>) => Run | Promise<Run>>
> = {
    async [BotAiRunStatus.Finished](run) {
        return await moveOn(run);
    },
    [BotAiRunStatus.Failed](run) {
        const failedTurnCount = run.failedTurnCount + 1;
        return failedTurnCount >= maxFailedTurns
            ? halt({
                  run,
                  reason: `its AI failed ${failedTurnCount} times in a row.`,
              })
            : {
                  ...run,
                  failedTurnCount,
                  nextPrompt: `Agent Storm self-improvement: your last turn failed. Continue, per ${instructionsPath}.`,
              };
    },
    [BotAiRunStatus.TimedOut](run) {
        const problemName = run.currentProblem ? `"${run.currentProblem}"` : 'that problem';
        return {
            ...run,
            nextPrompt: `Agent Storm self-improvement: your last turn ran too long and was stopped. Abandon ${problemName}: undo its unfinished edits, log it under Abandoned in the journal, and take a different problem, per ${instructionsPath}.`,
        };
    },
    [BotAiRunStatus.OverSpendLimit](run) {
        return halt({
            run,
            reason: 'it reached its daily spend limit.',
        });
    },
};

/**
 * Ends the run. Returns the prompt that hands its changes to the user in the bot's AI Chat tab,
 * which applies them once they approve there, or undefined when it has none.
 */
async function wrapUp({
    run,
    checkoutPath,
    report,
}: Readonly<{
    run: Readonly<Run>;
    checkoutPath: string;
    report: BotRun['report'];
}>) {
    await saveRun({
        ...run,
        phase: RunPhase.WrappedUp,
        isTurnPending: false,
    });
    const proposalsDir = join(stateDir, 'proposals');
    const patchPath = join(proposalsDir, `${getNowInIsoString().replaceAll(':', '-')}.patch`);
    await mkdir(proposalsDir, {
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
        await report('The user is back. This run had no changes to propose.');
        return undefined;
    }
    await report(
        "The user is back, so this run is over. Its changes are proposed in the bot's AI Chat tab.",
    );
    return [
        [
            'Agent Storm self-improvement: the user is back, so this run is over. Stop investigating and change nothing else.',
            run.phase === RunPhase.Halted ? `The run had stopped early: ${run.haltReason}` : '',
        ]
            .filter(Boolean)
            .join(' '),
        `Reply with a very high level summary of this run's changes, which are all in ${patchPath}: a few short bullets grouped by goal (speed, token use, bugs, cleanup, GitHub rate limits), with no file-by-file detail. Then propose copying them into the live checkout at ${checkoutPath}, and tell the user to read the patch itself before approving, since the summary leaves out detail.`,
        `Do not touch the live checkout until the user approves here. Once they do, run \`git -C ${checkoutPath} apply ${patchPath}\` and report the result. If it fails, say why and change nothing. If they decline, do nothing.`,
        `If the user asks for changes first, make them in this scratch copy, then rewrite the patch with \`git add --all && git diff --cached --binary ${run.baselineCommit} --output=${patchPath}\` before applying it.`,
    ].join('\n\n');
}

/**
 * Starts a run on a fresh scratch copy of the checkout, carrying over the previous run's changes
 * the user hasn't copied over yet. Returns the first turn's prompt.
 */
async function startRun({
    previousRun,
    checkoutPath,
}: Readonly<{previousRun: Readonly<Run> | undefined; checkoutPath: string}>) {
    const startedAt = Date.now();
    const carriedPatchPath = join(stateDir, 'carried.patch');
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
              unappliedPatchPath: join(stateDir, `unapplied-${startedAt}.patch`),
          })
        : undefined;
    try {
        await updateFixRequestDigest({
            checkoutPath,
            ledgerPath: join(stateDir, 'fix-requests.json'),
            digestPath: join(findScratchNotesDir(scratchPath), 'self-improvement-fix-requests.md'),
        });
    } catch (error) {
        log.warning(`Reading the user's fix requests failed: ${extractErrorMessage(error)}`);
    }
    return await saveRun({
        startedAt,
        baselineCommit,
        phase: RunPhase.Working,
        isTurnPending: false,
        nextPrompt: [
            `Agent Storm self-improvement: a new run started on a fresh copy of the live checkout. Follow ${instructionsPath}.`,
            carryNote,
        ]
            .filter(Boolean)
            .join(' '),
        haltReason: '',
        failedTurnCount: 0,
        stalledTurnCount: 0,
        progressFingerprint: '',
        codeFingerprint: '',
        currentProblem: '',
        currentProblemTurnCount: 0,
        currentProblemStalledTurnCount: 0,
    });
}

/**
 * While the user has been away for hours, works on a scratch copy of agent-storm's checkout to make
 * it better, one problem per AI turn. Once they're back, proposes its changes in its AI Chat tab,
 * which only copies them into the live checkout once the user approves there.
 */
export default defineBot({
    description:
        "Improves agent-storm on a scratch copy of this checkout while you're away, then proposes its changes for you to approve once you're back.",
    interval: {
        minutes: 5,
    },
    ai: {
        provider: BotAiProvider.Codex,
        model: 'gpt-6.2-sol',
        effort: BotAiEffort.Max,
    },
    limits: {
        maxSpendPerDayUsd: 200,
        maxAiRunDuration: {
            minutes: 45,
        },
    },
    async execute({agentStorm, run}) {
        const lastUserInputAt = await agentStorm.readLastUserInputAt();
        if (lastUserInputAt == undefined) {
            return undefined;
        }
        const checkoutPath = process.cwd();
        const storedRun = await readRun();
        const current =
            storedRun?.phase === RunPhase.Working && storedRun.isTurnPending
                ? await saveRun({
                      ...(await turnSettlers[run.aiStatus || BotAiRunStatus.Finished](storedRun)),
                      isTurnPending: false,
                  })
                : storedRun;
        if (storedRun?.phase === RunPhase.Working && current?.phase === RunPhase.Halted) {
            await run.report(`Self-improvement stopped early: ${current.haltReason}`);
        }
        if (
            current &&
            current.phase !== RunPhase.WrappedUp &&
            lastUserInputAt > current.startedAt
        ) {
            const wrapUpPrompt = await wrapUp({
                run: current,
                checkoutPath,
                report: run.report,
            });
            return wrapUpPrompt
                ? {
                      prompt: wrapUpPrompt,
                      cwd: scratchPath,
                  }
                : undefined;
        } else if (current?.phase === RunPhase.Halted) {
            return undefined;
        }
        const isAwayLongEnough =
            Date.now() - lastUserInputAt >=
            convertDuration(
                {
                    hours: 3,
                },
                {
                    milliseconds: true,
                },
            ).milliseconds;
        const working =
            current?.phase === RunPhase.Working
                ? current
                : isAwayLongEnough
                  ? await startRun({
                        previousRun: current,
                        checkoutPath,
                    })
                  : undefined;
        if (!working) {
            return undefined;
        }
        await saveRun({
            ...working,
            isTurnPending: true,
        });
        return {
            prompt: working.nextPrompt,
            cwd: scratchPath,
            isUnattended: true,
        };
    },
});
