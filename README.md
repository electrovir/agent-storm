# agent-storm

Web-based multi-folder development environment for running AI coding sessions (Claude, by default) alongside a shell — one pair of panes per git repo / git worktree — plus an embedded VS Code editor per folder. Everything runs locally over your LAN.

## Get started

```bash
npx agent-storm@latest
```

The first run downloads the latest release from GitHub and installs it under `~/.agent-storm`. Every run then starts agent-storm in the background, if it isn't already running, and opens it in your browser. agent-storm updates itself after that, so the command only needs to run again to reopen it.

### From source

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

If you lose the secret, delete `~/.agent-storm/server-state/auth-secret` (or `.not-committed/auth-secret` at the repo root when running from source) and restart agent-storm.

## Config

User settings live at `~/.agent-storm/settings.json` (YAML and TOML also work, and are converted to JSON on the first save). The settings modal (gear icon, top of the sidebar) edits it in place. A repo can add its own read-only defaults in `.agent-storm/agent-storm.config.ts` (or `.js`, `.json`, `.yaml`, `.toml`) in any folder from the repo up to your home folder. The same file at the repo root defines the repo's bots (see [`@agent-storm/bot`](packages/bot)). Type a TS config with `defineAgentStormConfig` from [`@agent-storm/config`](packages/config).

## Built-in skills

Every Agent Storm thread gets the `agent-storm` plugin's skills: `/agent-storm:start-worktree` (start work in a new worktree), `/agent-storm:open-worktree` (the same, then open a PR), and `/agent-storm:open-pr` (review, commit, and open a PR). They also work in plain Claude Code, making the worktree with `git worktree add` and reading the repo's `postWorktreeCmd` and `reviewSkill` with [`@agent-storm/config`](packages/config)'s `agent-storm-config` command.

To turn them on for everyone in a repo, including people who don't run Agent Storm, add this to the repo's `.claude/settings.json`:

```json
{
    "enabledPlugins": {
        "agent-storm@agent-storm": true
    },
    "extraKnownMarketplaces": {
        "agent-storm": {
            "source": {
                "repo": "electrovir/agent-storm",
                "source": "github"
            }
        }
    }
}
```

To install them for yourself instead, run `/plugin marketplace add electrovir/agent-storm`, then `/plugin install agent-storm@agent-storm`, in Claude Code. Agent Storm threads use their own copy of the plugin either way, so an installed copy doesn't list the skills twice.
