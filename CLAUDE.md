# agent-storm

## Dev server ports

When `npm start` is running:

- Frontend (vite): http://localhost:5173/
- Backend: http://127.0.0.1:3000/

Combined output is teed to `.logs/dev.log` — see the `read-backend-logs` skill.

## Branch deviations

`high-level-deviations-from-master.md` (repo root) tracks major architectural differences this branch has from master. Keep it concise — small bullet points only. Whenever a large shift or adjustment lands, add an entry there.

## Branch features

`branch-features.md` (repo root) is the at-a-glance inventory of every feature on this branch. **Any time the user asks to change, add, remove, or adjust something, append one 10–15 word bullet describing the change.** Update existing bullets in place when a change supersedes them, and remove bullets when the feature is deleted. Keep entries terse — this file must stay scannable.

## Notes

- Frontend dev server is `virmator frontend` (vite); it ignores the Preview MCP's assigned port and binds to 5173, so verify via HMR on the user's running server rather than spawning a new preview.
- When asked to "embed an existing button" on a new route, duplicating the button's render+handler is fine — the existing instance stays in place and shared extraction would have been over-abstracting for one reuse.
- Keep button polish flat — the user rejects glow, elevation, and hover-lift effects.
- To restyle a third-party shadow-DOM element (e.g. vira-json-form's +/- buttons), set its CSS var on `:root`; local selectors can't cross shadow boundaries.
- vira-button's shadow DOM lays out icon+text horizontally; vertical layouts need raw buttons.
- `npm start` tees combined backend+frontend output to `.logs/dev.log` (lines prefixed `[backend]`/`[frontend]`); use the `read-backend-logs` skill or `tail -n 200 .logs/dev.log` to inspect the user's running servers.
- Don't create or use `.claude/launch.json` — rely on the user's running `npm start` instead.
- Element-vir components emit custom events via `defineElementEvent` and `dispatch(new events.X(detail))`.
- Default icon-only ViraButton to ViraSize.Medium (32px) — Small (28px) is too tight to click.
- Auth secret lives in localStorage (port-scoped) — vite port changes silently force re-auth.
- Do NOT put app state in localStorage. Persist it to the agent-storm config (`~/.config/agent-storm.json`) via a server endpoint instead. localStorage is per-browser, per-port, easily wiped, and invisible to other clients of the same workspace — anything we want to survive a reload or sync across the desktop+browser builds belongs in the config. The auth secret is the lone exception because the bearer token has to live on the client.
- Vira menu-item hover/active reads `--vira-form-selection-*-color`; override per theme or dropdowns show brand-blue.
- Backend runs via `tsx watch` and auto-restarts on server/common edits; routes that look like CORS errors usually mean the restart crashed — check `.logs/dev.log`.
- `packages/common` is a shared TS library — no vite config or `virmator frontend` scripts.
- `git worktree add --no-checkout` rejects existing dirs and leaves the index empty — run `git reset`.
- "Skill" / "automate" means write a runnable script (e.g. `scripts/foo.mjs`); LLM only maps request → script args, never does the work.
- Screenshots: run `node scripts/screenshot.mjs <path> [--click=<selector>]` — do NOT drive Claude in Chrome MCP for captures.
- Headless Playwright: use `executablePath: '/usr/bin/google-chrome'` and seed `.not-committed/auth-secret` into localStorage to skip the auth modal.
- Playwright is in `node_modules` via `eslint-plugin-playwright` (transitive) — usable in scripts without explicit install.
- Frontend reporter only catches uncaught errors; caught API failures need explicit reportClientError calls.
- Electron ESM main hangs on `await app.whenReady()` at top-level; use `.then()` callback instead.
- Adding a field to `folderInfoShape` requires backfilling it in BOTH persisted caches or `/folders` shape-validation fails on restart: `normalizeCachedFolderInfo` (folder-info-cache.json) and the `PrInfo` path (`prSnapshotFromPr` must coerce stale github-cache.json entries that predate the field).
