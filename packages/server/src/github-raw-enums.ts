import {GitHubCheckState} from '@agent-storm/common';
import {mapEnumToObject, removeSuffix} from '@augment-vir/common';

/**
 * Values GitHub's GraphQL API (and `gh --json`, which passes them through) uses, so code that
 * branches on a GitHub answer names them instead of retyping their strings.
 */

/** GitHub's `PullRequestState`. */
export enum RawPrState {
    Open = 'OPEN',
    Closed = 'CLOSED',
    Merged = 'MERGED',
}

/** GitHub's `PullRequestReviewState`. */
export enum RawReviewState {
    Approved = 'APPROVED',
    ChangesRequested = 'CHANGES_REQUESTED',
    Commented = 'COMMENTED',
    Dismissed = 'DISMISSED',
    Pending = 'PENDING',
}

/** GitHub's `PullRequestReviewDecision`. `gh` prints an empty string when there is none. */
export enum RawReviewDecision {
    Approved = 'APPROVED',
    ChangesRequested = 'CHANGES_REQUESTED',
    ReviewRequired = 'REVIEW_REQUIRED',
}

/** GitHub's `MergeStateStatus`. */
export enum RawMergeState {
    Behind = 'BEHIND',
    Blocked = 'BLOCKED',
    Clean = 'CLEAN',
    Dirty = 'DIRTY',
    Draft = 'DRAFT',
    HasHooks = 'HAS_HOOKS',
    Unknown = 'UNKNOWN',
    Unstable = 'UNSTABLE',
}

/** GitHub's `MergeableState`. */
export enum RawMergeable {
    Conflicting = 'CONFLICTING',
    Mergeable = 'MERGEABLE',
    Unknown = 'UNKNOWN',
}

/** GitHub's `CommentAuthorAssociation`: the author's relationship to the repo. */
export enum RawAuthorAssociation {
    Collaborator = 'COLLABORATOR',
    Contributor = 'CONTRIBUTOR',
    FirstTimer = 'FIRST_TIMER',
    FirstTimeContributor = 'FIRST_TIME_CONTRIBUTOR',
    Mannequin = 'MANNEQUIN',
    Member = 'MEMBER',
    None = 'NONE',
    Owner = 'OWNER',
}

/**
 * Whether GitHub itself lists the author as someone with access to the repo. A contributor has only
 * had a PR merged, which anyone can get by forking.
 */
export const collaboratorAssociations: Readonly<Record<RawAuthorAssociation, boolean>> = {
    [RawAuthorAssociation.Collaborator]: true,
    [RawAuthorAssociation.Member]: true,
    [RawAuthorAssociation.Owner]: true,
    [RawAuthorAssociation.Contributor]: false,
    [RawAuthorAssociation.FirstTimer]: false,
    [RawAuthorAssociation.FirstTimeContributor]: false,
    [RawAuthorAssociation.Mannequin]: false,
    [RawAuthorAssociation.None]: false,
};

/** GitHub's `__typename` for the `Actor`s that write comments. */
export enum RawActorType {
    Bot = 'Bot',
    EnterpriseUserAccount = 'EnterpriseUserAccount',
    Mannequin = 'Mannequin',
    Organization = 'Organization',
    User = 'User',
}

/**
 * Review bots trusted like collaborators: their comments are work without anyone's 👍, and their
 * PRs auto-start reviews. GitHub reserves an app's login for that app, and a user can't take it,
 * but a comment only counts once GitHub also says its author is a `Bot`. The config's
 * `trustedBotLogins` adds to these.
 */
const builtInTrustedBotLogins: ReadonlyArray<string> = [
    'copilot-pull-request-reviewer',
    'copilot',
    'claude',
    'chatgpt-codex-connector',
    'openai-codex',
];

/** GitHub's GraphQL API names an app `flax-bot` where its REST API says `flax-bot[bot]`. */
function normalizeBotLogin(login: string) {
    return removeSuffix({
        value: login.trim().toLowerCase(),
        suffix: '[bot]',
    });
}

/**
 * A built-in review bot or one in the config's `trustedBotLogins`. GitHub has to say the account is
 * a `Bot` as well as match the login.
 */
export function isTrustedBot({
    author,
    trustedBotLogins,
}: Readonly<{
    author:
        | Readonly<{
              __typename: RawActorType;
              login: string;
          }>
        | null
        | undefined;
    trustedBotLogins: ReadonlyArray<string>;
}>) {
    return (
        author?.__typename === RawActorType.Bot &&
        [
            ...builtInTrustedBotLogins,
            ...trustedBotLogins,
        ]
            .map(normalizeBotLogin)
            .includes(normalizeBotLogin(author.login))
    );
}

/** GitHub's `PullRequestReviewThreadSubjectType`. */
export enum RawThreadSubjectType {
    Line = 'LINE',
    File = 'FILE',
}

/**
 * A status check's result as `gh pr view --json statusCheckRollup` reports it: a `CheckRun`'s
 * `CheckConclusionState`, or a `StatusContext`'s `StatusState`.
 */
export enum RawCheckResult {
    ActionRequired = 'ACTION_REQUIRED',
    Cancelled = 'CANCELLED',
    Error = 'ERROR',
    Expected = 'EXPECTED',
    Failure = 'FAILURE',
    Neutral = 'NEUTRAL',
    Pending = 'PENDING',
    Skipped = 'SKIPPED',
    Stale = 'STALE',
    StartupFailure = 'STARTUP_FAILURE',
    Success = 'SUCCESS',
    TimedOut = 'TIMED_OUT',
}

/** A `CheckRun`'s `CheckStatusState`. */
export enum RawCheckStatus {
    Completed = 'COMPLETED',
    InProgress = 'IN_PROGRESS',
    Pending = 'PENDING',
    Queued = 'QUEUED',
    Requested = 'REQUESTED',
    Waiting = 'WAITING',
}

/** GitHub's `__typename` for the members of a status check rollup's `contexts` union. */
export enum RawCheckContextType {
    CheckRun = 'CheckRun',
    StatusContext = 'StatusContext',
}

/**
 * What each check result shows as. A neutral, skipped, or stale run has nothing to report, while a
 * cancelled one counts as failed, the same as `check-pr.sh` in the watch-pr skill.
 */
export const checkResultStates: Readonly<Record<RawCheckResult, GitHubCheckState>> = {
    [RawCheckResult.ActionRequired]: GitHubCheckState.Failure,
    [RawCheckResult.Cancelled]: GitHubCheckState.Failure,
    [RawCheckResult.Error]: GitHubCheckState.Failure,
    [RawCheckResult.Failure]: GitHubCheckState.Failure,
    [RawCheckResult.StartupFailure]: GitHubCheckState.Failure,
    [RawCheckResult.TimedOut]: GitHubCheckState.Failure,
    [RawCheckResult.Expected]: GitHubCheckState.Pending,
    [RawCheckResult.Pending]: GitHubCheckState.Pending,
    [RawCheckResult.Neutral]: GitHubCheckState.None,
    [RawCheckResult.Skipped]: GitHubCheckState.None,
    [RawCheckResult.Stale]: GitHubCheckState.None,
    [RawCheckResult.Success]: GitHubCheckState.Success,
};

/** Results that mean a check failed. */
export const failedCheckResults = mapEnumToObject(RawCheckResult, (result) => {
    return checkResultStates[result] === GitHubCheckState.Failure;
});

/** Statuses of a check run that hasn't finished yet. */
export const runningCheckStatuses: Readonly<Record<RawCheckStatus, boolean>> = {
    [RawCheckStatus.InProgress]: true,
    [RawCheckStatus.Pending]: true,
    [RawCheckStatus.Queued]: true,
    [RawCheckStatus.Requested]: true,
    [RawCheckStatus.Waiting]: true,
    [RawCheckStatus.Completed]: false,
};

/** Merge states in which GitHub's merge button is green. */
export const mergeableMergeStates: Readonly<Record<RawMergeState, boolean>> = {
    [RawMergeState.Clean]: true,
    [RawMergeState.HasHooks]: true,
    [RawMergeState.Behind]: false,
    [RawMergeState.Blocked]: false,
    [RawMergeState.Dirty]: false,
    [RawMergeState.Draft]: false,
    [RawMergeState.Unknown]: false,
    [RawMergeState.Unstable]: false,
};
