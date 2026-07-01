# High-level deviations from master

Major architectural shifts introduced on this branch versus upstream master. Keep entries concise.

- Worktrees are stored explicitly in `~/.config/agent-storm.json` under each repo (`worktrees: [{path, isBase}]` + `isWorktreeLayout`) — sidebar reads from config instead of re-scanning the filesystem each refresh.
- `packages/server/src/worktree-reconcile.ts` is the only consumer of `listWorktreeChildren` for sidebar purposes; it runs on every config save, on every worktree create/delete, and at sweep start, persisting drift back to disk.
- `RefreshTarget.isBase` flows from `repo.worktrees[].isBase` so `placeholderFolderInfo` knows up-front which worktree is the base branch (the base worktree no longer flashes in the sidebar before the first sweep finishes).
