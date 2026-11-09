import {type AppContext} from '@agent-storm/core/frontend';
import {assertWrap} from '@augment-vir/assert';
import {Observable} from 'element-vir';
import {createPrQueues, type PrQueueKind} from './pr-queues.js';
import {createPrReviews} from './pr-reviews.js';

export const reviewActivityId = 'review';

/** Everything the Review plugin keeps for the app's whole life. */
export function createReviewState() {
    return {
        prQueues: createPrQueues(),
        /** PR details and sent verdicts, shared by every tab that reviews a PR. */
        prReviews: createPrReviews(),
        /**
         * The Review tab's list. Undefined until picked this session, so the stored pick can load
         * later.
         */
        queue: new Observable<PrQueueKind | undefined>({
            defaultValue: undefined,
        }),
        /**
         * Set to a new object each time the user selects a PR, which clears that PR's review folder
         * error so the folder is asked for again. Notifies on every set, since each new object is a
         * new retry.
         */
        retry: new Observable<Readonly<{key: string}> | undefined>({
            equalityCheck: undefined,
            defaultValue: undefined,
        }),
    };
}

export type ReviewState = ReturnType<typeof createReviewState>;

/** The Review activity's state, which the activity creates for the window's whole life. */
export function findReviewState({activityStates}: Readonly<Pick<AppContext, 'activityStates'>>) {
    return assertWrap.isDefined(activityStates[reviewActivityId]) satisfies unknown as ReviewState;
}
