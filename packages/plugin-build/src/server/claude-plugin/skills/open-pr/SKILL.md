---
name: open-pr
description: Review the current branch with the repo's review skill when one is set, fix every issue it reports, commit, and open a ready PR the way the repo's and the user's instructions say. Aborts before committing when the review finds a major issue. Use when the user types /open-pr.
disable-model-invocation: true
---

<!-- cspell:word toplevel -->

# Open PR

The user invoking this skill is the explicit instruction for committing the branch's uncommitted work, pushing the branch, opening its PR, and editing that PR's body and assignee. It sanctions no other git write.

Stop before Step 1 when the current branch is the repo's default branch (`git rev-parse --abbrev-ref origin/HEAD`) or already has an open PR (`gh pr view --json url,state`), and say which.

## Step 1: Review and fix

Find the repo's review skill: the `reviewSkill` of this thread's folder in Agent Storm's `list_folders`, a slash command with any arguments. When it is set, invoke the skill it names with those arguments. It may apply fixes itself and report the rest. Then fix everything its report left open, including any validation failure. Drop a finding only after verifying it is wrong, and say why in one line. When no review skill is set, or Agent Storm's tools are unavailable, skip the review.

Abort when any of these is true, leaving every edit in the working tree and committing nothing:

-   A security hole, or suspected secrets or personal data (masked, never raw).
-   A migration that destroys data.
-   A fix that needs a redesign, deletes or reverses the author's own change, or changes behavior the author must decide (concurrency, data flow, which id a call site passes).
-   A requirement of the linked ticket reported as not addressed or partial.
-   The type check or a test still failing after a fix you cannot make pass without guessing.

On abort, list each major issue with `path:line` and the decision it needs, then stop.

## Step 2: Commit

Run Steps 2 and 3 from the repo root (`cd "$(git rev-parse --show-toplevel)"`).

1. Run the repo's formatter and spell check, when it has them, on the changed files. Fix any spelling failure.
2. Abort without committing when any changed or untracked file looks like a credential (`.env*`, `*.pem`, `*.key`, or contents holding a private key), naming each path.
3. Stage every changed and untracked file by path, the user's own uncommitted changes included, since the PR must carry them. Never stage anything under `.not-committed/`.
4. Commit once, titled the way the repo's instructions and its recent history (`git log --format=%s -20 origin/HEAD`) title commits, saying what the change does. Add the ticket's id where the repo's convention puts it. Skip the commit when nothing is left uncommitted.

Keep secrets and personal data out of the commit title and the PR body.

## Step 3: Open the PR

When the repo's or the user's instructions say how to open a PR (an author, a script, a title format), follow them. Otherwise:

1. `git push -u origin HEAD`.
2. `gh pr create --title "<title>" --body-file <template>`, where the title is the first commit's subject past the base, and the template is the repo's PR template (such as `.github/pull_request_template.md`), or `--body ''` when it has none. Add `--base <branch>` when this branch was cut from another branch with an open PR.
3. Fill each section of the template per its comments, write the result to `.not-committed/pr-body.md`, and apply it with `gh pr edit <number> --body-file .not-committed/pr-body.md`.
4. `gh pr edit <number> --add-assignee @me`.

Never open a draft.

## Report

The PR URL, which identity opened it, the commit and PR titles, and a one-line count of review fixes applied, or that no review skill is set.
