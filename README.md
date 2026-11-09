# agent-storm

Web-based multi-folder development environment for running AI coding sessions (Claude, by default) alongside a shell — one pair of panes per git repo / git worktree — plus an embedded VS Code editor per folder. Everything runs locally over your LAN.

## Get started

```bash
git clone https://github.com/electrovir/agent-storm.git
cd agent-storm
npm ci
npm start
```

Then open the logged localhost URL in your browser.

To run a second, separate instance beside it (say, to debug agent-storm from inside agent-storm), run `npm run start:debug`. It gets its own ports (`BACKEND_PORT`, `FRONTEND_PORT`), pty daemon (`AGENT_STORM_INSTANCE`), and data folder (`AGENT_STORM_DATA_DIR`, `~/.agent-storm-debug`), and its auth secret and caches live under `.not-committed/instances/debug/`. Set those env vars on `npm start` yourself for any other instance.

## Auth

On first launch the backend generates a random bearer secret and prints it once to the terminal:

```
auth secret: 3f9a…
```

Copy that string and paste it into the browser when prompted.

If you lose the secret, delete `.not-committed/auth-secret` at the repo root and run `npm start` again.

## Config

User settings live at `~/.agent-storm/settings.json` (YAML and TOML also work, and are converted to JSON on the first save). The settings modal (gear icon, top of the sidebar) edits it in place. A repo can add its own read-only defaults in `.agent-storm/settings.json` (or `.yaml` or `.toml`) in any folder from the repo up to your home folder.
