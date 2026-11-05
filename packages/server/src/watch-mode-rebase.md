<!-- cspell:words mktemp reflog upstreamed autosquash -->

# Rebasing onto the PR base

Move this branch onto the latest version of its PR's base without a three-way merge. Capture what the branch changes, reset to the new base, and re-implement those changes on top of it, adapting them to whatever moved underneath. Re-implementing avoids the conflict markers a plain `git rebase` produces when the surrounding code has shifted.

This rewrites history. Watch mode already authorizes that, so never ask before the reset. Do not push here: the merge conflict section of the watch mode instructions pushes once the result is reviewed.

## Finish a rebase already in progress

A real `git rebase` that stopped on a conflict must be driven to completion, not reset away. Resetting mid-rebase throws away the commits it already replayed. Check before anything else:

```bash
[ -d "$(git rev-parse --git-path rebase-merge)" ] || [ -d "$(git rev-parse --git-path rebase-apply)" ] && echo "rebase in progress"
```

If one is in progress, skip every other section and do this instead:

1. Read `git status` for the stopped-at commit and the unmerged paths. `git rebase --show-current-patch` shows the commit being replayed, which tells you the intent behind the conflicting hunks.
2. Resolve every conflicted file by hand. Keep both sides' intent: the replayed commit's change adapted onto the new base, never a blind "take ours" or "take theirs". Remove every conflict marker.
3. `git add` the resolved paths, then `git rebase --continue`. Repeat for each later stop until the rebase reports it is done. Never `git rebase --abort`: it throws away every commit already replayed. Never `git rebase --skip` a commit that still carries a change, since a skip drops it silently.
4. A resolution that nets out to no change is the case to watch. On the default merge backend, `--continue` succeeds and drops that commit with no message. On the apply backend (`--apply` or `rebase.backend=apply`), `--continue` refuses with `No changes - did you forget to use 'git add'?`: confirm with `git rebase --show-current-patch` that the base already holds the change, then `git rebase --skip`. Either way, name the dropped commit in your summary.
5. Verify per "Verify" below, then refresh dependencies per "Reset to the new base" if the rebase moved `HEAD` onto a base with a different lockfile.

## Find the base

1. The base is the PR's base branch: `gh pr view --json baseRefName --jq .baseRefName`. With no PR, it is the repo's default branch: `gh repo view --json defaultBranchRef --jq .defaultBranchRef.name`.
2. A base other than the default branch means a stacked PR: this branch carries copies of its parent branch's commits. Re-implementing would sweep the parent's commits in as this branch's own, so move it instead:
    1. Find the parent's old tip with `git merge-base --fork-point <base> HEAD`. It reads the branch's reflog to find where this branch forked off the parent before the parent was rewritten. If it prints nothing, stop and report it rather than guessing: guessing too low replays the parent's old commits on top of their new copies.
    2. Run `git rebase --onto <base> <that sha>`, finishing any conflict per the section above. Use the local `<base>` branch, since worktrees share local branches and it may hold a parent rewrite that is not pushed yet. Fall back to `origin/<base>` when there is no local branch, or when `origin/<base>` is ahead of it.
    3. Skip to "Verify".

## Capture the branch

```bash
BRANCH=$(git branch --show-current)
SCRATCH_DIR=$(mktemp -d -t "rebase-${BRANCH//\//-}-XXXX")
git fetch origin <base>
git diff origin/<base>...HEAD > "$SCRATCH_DIR/committed.patch"
git diff > "$SCRATCH_DIR/unstaged.patch"
git diff --cached > "$SCRATCH_DIR/staged.patch"
NUMBER=0
for SHA in $(git rev-list --reverse --no-merges origin/<base>..HEAD); do
    NUMBER=$((NUMBER + 1))
    git show -s --format='%B' "$SHA" > "$SCRATCH_DIR/commit-$NUMBER-message.txt"
    git show --format='# %H %s' "$SHA" > "$SCRATCH_DIR/commit-$NUMBER.patch"
done
MERGE_BASE=$(git merge-base HEAD origin/<base>)
git merge-tree --name-only --merge-base="$MERGE_BASE" HEAD origin/<base> | awk 'NR>1 && /^$/{exit} NR>1' > "$SCRATCH_DIR/conflicted-files.txt" || true
```

Each original commit becomes one commit again, under its original message. `conflicted-files.txt` lists the files a plain rebase would have conflicted on, which are the ones that need the most care. Read every patch and build an understanding of what each change does and why. That understanding is what gets reapplied; the patches are a safety net.

If `git status` shows untracked files, copy them into `$SCRATCH_DIR/untracked/` before the reset. `git reset --hard` overwrites an untracked file when the new base tracks the same path, and the reflog cannot recover it.

## Reset to the new base

```bash
git reset --hard origin/<base>
```

When the lockfile differs from the old base, reinstall dependencies with the lockfile's clean install (`npm ci` for npm, `pnpm install --frozen-lockfile`, and so on), then run any setup the repo's README or `AGENTS.md` says to run after installing.

## Reapply each commit

Work through the commits oldest first, so each lands on top of the ones before it. For each:

1. Re-implement `commit-N.patch` on the new base: read the affected files in their new state and make the same logical change, adapting to renamed symbols, moved files, and changed APIs. When the base already contains an equivalent change, skip that part and note it. Never blindly `git apply` the patch. For a large, self-contained change, `git apply --3way "$SCRATCH_DIR/commit-N.patch"` is an acceptable starting point, as long as you inspect every hunk and resolve rejects by hand.
2. With the last commit, also reapply `staged.patch` and `unstaged.patch`.
3. If the commit added a migration whose file or directory name starts with a timestamp, rename it so it sorts after every migration on the new base. Use the repo's migration tooling when it has a rename or re-timestamp command. Never rename a migration the base already has.
4. Format the files it touched with the repo's formatter.
5. Commit it with the original message, byte for byte:

    ```bash
    git add -A
    git commit --file="$SCRATCH_DIR/commit-N-message.txt" --cleanup=verbatim
    ```

    When `git commit` reports nothing to commit, the base already holds that change: skip it rather than forcing an empty commit, and name it in your summary.

If the branch had no commits ahead of the base, there is no message to reuse. Leave the reapplied changes uncommitted for the watch mode instructions' commit rules to handle.

## Verify

1. Run the repo's type check, using the command its `AGENTS.md` or `package.json` scripts name. Run only the specific test files that cover the changed files, per the watch mode instructions' rule against running whole suites.
2. Fix any breakage the new base caused. That is the point of re-implementing instead of rebasing.
3. Fold each fix into the commit whose change it adapts: `git commit --fixup=<sha>` per fix, then `git rebase --autosquash origin/<base>`. A fix to the tip commit can use `git commit --amend --no-edit` instead. If the autosquash stops on a conflict, finish it per the first section.

PRs stacked on top of this branch are left alone. List them in your summary (`gh pr list --base "$(git branch --show-current)" --state open`), since they now need rebasing too.

## Summary

Add to the pass summary: the base and the commit it was reset to, the scratch directory, the files from `conflicted-files.txt` and how each was resolved, any commit skipped because the base already had it, and type check and test status.
