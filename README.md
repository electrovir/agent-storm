# agent-storm

Web-based multi-folder development environment for running AI coding sessions (Claude, by default) alongside a shell — one pair of panes per git repo / git worktree — plus an embedded VS Code editor per folder. Everything runs locally over your LAN.

## Migrating from an older version

To carry over your repo list and preferences from the old CLI version of agent-storm, convert the old TOML file (`~/.config/agent-storm.toml`) to JSON (`~/.config/agent-storm.json`) following the schema (`configJsonSchema`) defined in `packages/common/src/api.ts`.

## Get started

```bash
git clone https://github.com/electrovir/agent-storm.git
cd agent-storm
npm ci
npm start
```

Then open the logged localhost URL in your browser.

## Auth

On first launch the backend generates a random bearer secret and prints it once to the terminal:

```
auth secret: 3f9a…
```

Copy that string and paste it into the browser when prompted.

If you lose the secret, delete `.not-committed/auth-secret` at the repo root and run `npm start` again.

## Config

User config lives at `~/.config/agent-storm.json`. The settings modal (gear icon, top of the sidebar) edits it in-place.
