---
name: open-worktree
description: Same as `/start-worktree` (a fresh worktree through Agent Storm, then the work), then ships the work with `/open-pr` (review and fix, commit, open the PR), and starts `/manual-review here` on the PR when that skill is available and someone other than the current GitHub user opened it. Use when the user wants work started in its own worktree and shipped straight to a PR. Agent Storm also runs it on the first message of every thread `create_thread` starts with `isInWorktree`.
argument-hint: '<description of the work> | <ticket the repo knows how to start>'
---

# Open Worktree

The user invoking this skill is the explicit instruction for everything `/start-worktree` and `/open-pr` sanction, plus the per-sub-issue commits in Step 2 and what `/manual-review here` does in Step 3. It sanctions no other git write.

A coordinator, a thread that hands several pieces of work to their own worktrees, never runs this skill itself, since its Step 1 would move the coordinator into the first worktree. It calls `create_thread` with `isInWorktree: true` and each piece of work as the message, plus `branchName` when the branch name is fixed, and Agent Storm runs this skill on the message in each new thread.

## Step 1: Do the work with `/start-worktree`

Follow `../start-worktree/SKILL.md`, beside this skill's folder, with the user's input, skipping the review skill run in its "Do the work" section, since `/open-pr` runs it. When its Step 3 hands the work to a continuation prompt, that prompt must also say to skip that review run and then follow Steps 2 and 3 of Agent Storm's `open-worktree` skill.

If any step stops, stop here too and surface its report, leaving the work uncommitted.

## Step 2: Ship it with `/open-pr`

Once the work is validated and its ticket, if any, is started, follow `../open-pr/SKILL.md` from the worktree, with these changes:

-   When the work covered sub-issues, replace its Step 2 commit with one commit per sub-issue, in work order, each staging only that sub-issue's files (its review fixes included) and titled the way the repo titles commits, with that sub-issue's id. In its Step 3, title the PR for all of the work, with the parent ticket's id.
-   Nobody watches this thread, so in its Step 1 abort only for a security hole, suspected secrets or personal data, a migration that destroys data, or a failing check the caller's approved plan requires to pass before the PR opens. Keep those stop conditions even when they fall outside the plan. Defer every other abort reason, and every finding outside the caller's approved plan, unfixed, to a `Needs author decision` list at the top of the PR body, each with `path:line` and the decision it needs.
-   When the caller or the repo requires the PR to be opened as a specific author and that fails, stop instead of opening it as anyone else, and report the error.

When it stops or aborts, stop here too and surface its report.

## Step 3: Start the manual review

Run `gh pr view <number> --json author --jq .author.login`. When the author is not the current `gh` user (`gh api user --jq .login`), run `/manual-review here` from the worktree if `manual-review` is among this session's skills. The PR already exists, so it skips opening one. Skip this step when the current user is the author, since GitHub does not let a user review their own PR, or when the skill is unavailable.

## Report

Give the user everything the `/start-worktree` and `/open-pr` Reports list, plus `/manual-review here`'s review copy path or why Step 3 was skipped.
