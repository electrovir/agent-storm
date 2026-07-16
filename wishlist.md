# Wishlist

Ideas for this branch that are not implemented yet.

## Worktree sub-tasks

- Each sidebar worktree can reference other worktrees as "sub-tasks" — worktrees spun out OF it
  (e.g. via /wadlo-create-agent-storm-branch) that are specifically related to it, like carving just
  the frontend or just the backend slice out of a bigger branch.
- Not every spun-up branch qualifies: a branch created from some random other branch is NOT a
  sub-task. The relationship is "this worktree was split out of that parent task".
- After the relationship exists, the sidebar should surface it somehow. Current leaning: render the
  PARENT differently rather than the sub-tasks — e.g. the parent's name in a lighter gray instead of
  white while it has active sub-tasks (exact treatment undecided).

## Review-requested PR counter

- Bottom-left corner of the screen: a count of open PRs currently awaiting my review.
- Clickable — opens the GitHub page listing the PRs that need my review
  (e.g. github.com/pulls/review-requested).
