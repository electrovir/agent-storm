import {type PartialWithUndefined} from '@augment-vir/common';
import {defineShape, enumShape, nullableShape} from 'object-shape-tester';

/**
 * What `agentStorm.askQuestion` does when the bot runs outside Agent Storm.
 *
 * @category Main
 */
export enum StandaloneQuestion {
    /** Answers `undefined`. */
    Ignore = 'ignore',
    /** Answers with the first option, or `undefined` when there are none. */
    FirstOption = 'firstOption',
    /** Asks in the terminal when one is attached, otherwise answers with the first option. */
    Terminal = 'terminal',
    /** Throws, failing the run. */
    Fail = 'fail',
}

/**
 * What `agentStorm.startThread` does when the bot runs outside Agent Storm.
 *
 * @category Main
 */
export enum StandaloneThread {
    /** Starts nothing. */
    Ignore = 'ignore',
    /** Runs the prompt once through the agent CLI and waits for it to finish. */
    RunHeadless = 'runHeadless',
    /** Throws, failing the run. */
    Fail = 'fail',
}

/**
 * Runtime check for {@link StandalonePolicy}.
 *
 * @category Internal
 */
export const standalonePolicyShape = defineShape({
    question: nullableShape(enumShape(StandaloneQuestion)),
    thread: nullableShape(enumShape(StandaloneThread)),
});

/**
 * What each Agent Storm-only call does when the bot runs outside Agent Storm (the bare CLI or a
 * deployment). A bot's own policy wins over the config's, which wins over ignoring every call.
 *
 * @category Main
 */
export type StandalonePolicy = Readonly<
    PartialWithUndefined<{
        question: StandaloneQuestion;
        thread: StandaloneThread;
    }>
>;

/**
 * Fills in the policy each call follows, from the most specific of `policies` that sets it.
 *
 * @category Internal
 */
export function resolveStandalonePolicy(...policies: ReadonlyArray<StandalonePolicy | undefined>) {
    return {
        question:
            policies.find((policy) => policy?.question)?.question || StandaloneQuestion.Ignore,
        thread: policies.find((policy) => policy?.thread)?.thread || StandaloneThread.Ignore,
    };
}
