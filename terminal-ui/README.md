# agent-storm

A terminal UI for managing multiple AI coding sessions across project folders. Three-pane layout: folder picker, AI assistant (Claude Code by default), and a shell — all in one screen. Powered by [tmux](https://github.com/tmux/tmux/wiki/Installing).

<img src="example.png" alt="agent-storm example" width="100%">

## Getting started

1. Install agent-storm and [tmux](https://github.com/tmux/tmux/wiki/Installing):

    1. Tmux:
        ```
        brew install tmux # or: sudo apt install tmux
        ```
    2. agent-storm:
        ```sh
        curl --proto '=https' --tlsv1.2 -fsSL https://raw.githubusercontent.com/electrovir/agent-storm/dev/install.sh | bash
        ```

2. Run `ags` from any directory you want to work in:

    ```sh
    cd ~/repos/my-project
    ags
    ```

3. Press `a` in the sidebar to add more repos. agent-storm automatically detects worktree roots.

4. For repos using git worktrees, press `w` to create a new worktree. agent-storm will run your configured post-worktree command (e.g. `npm install`) automatically.

Press `?` in the sidebar for a full list of keybindings.

## Install

Requires [tmux](https://github.com/tmux/tmux/wiki/Installing):

```sh
# macOS
brew install tmux

# Linux
sudo apt install tmux
```

Then install agent-storm:

```sh
curl --proto '=https' --tlsv1.2 -fsSL https://raw.githubusercontent.com/electrovir/agent-storm/dev/install.sh | bash
```

This downloads the latest prebuilt binary for your platform and installs it to `/usr/local/bin` (macOS) or `~/.local/bin` (Linux). Both `agent-storm` and `ags` commands are available after install.

To update: `ags --update`

### Build from source

Requires [Rust](https://rustup.rs/) and [tmux](https://github.com/tmux/tmux/wiki/Installing).

```sh
git clone https://github.com/electrovir/agent-storm.git
cd agent-storm
cargo build --release
cp target/release/agent-storm /usr/local/bin/
ln -sf /usr/local/bin/agent-storm /usr/local/bin/ags
```

## Usage

```sh
# Browse repos from your config
ags

# Browse a specific directory (prompts to add if new)
ags ~/repos/my-project

# Add a repo to the config and exit
ags --add ~/repos/my-project

# Browse only one path, ignore config
ags --lone ~/repos/my-project

# Use a custom AI command
ags --ai-cmd "claude --model sonnet"

# Open config in $EDITOR
ags --config

# Update to latest release
ags --update

# Wipe the existing ags tmux session for this directory before launching
ags --reset
```

### Session persistence

`Ctrl+Q` detaches instead of killing — the tmux session stays alive in the background with every claude process still running. The next `ags` invocation in the same directory reattaches and picks up where you left off, which is how you apply an `ags --update` without losing state. Use `Ctrl+K` (or `ags --reset` from outside) when you actually want to wipe everything.

### Run from source (without installing)

```sh
git clone https://github.com/electrovir/agent-storm.git
cd agent-storm
cargo run -- ~/repos/my-project
```

### Layout

```
| Repos         | AI              | Shell           |
| my-project    |                 |                 |
|   *- dev      |  Claude Code    |  zsh / bash     |
|   -- feature  |                 |                 |
| other-repo    |                 |                 |
|                                                   |
| ?:help  ^Q:quit                                   |
```

The sidebar is a ratatui TUI showing your repos and their worktrees. The AI and shell panes are native tmux panes with full terminal features: scrollback, text selection, native cursor, Cmd+K clear.

### Keybindings

**Global (work from any pane — handled by tmux):**

| Key                         | Action                                      |
| --------------------------- | ------------------------------------------- |
| `Alt+1` / `Alt+2` / `Alt+3` | Focus sidebar / AI / shell pane             |
| `Alt+F`                     | Zoom (fullscreen) current pane              |
| `Ctrl+Q`                    | Detach (session + claude processes survive) |

**Sidebar (when sidebar is focused):**

| Key                 | Action                                         |
| ------------------- | ---------------------------------------------- |
| `j` / `k` or arrows | Navigate                                       |
| `Enter`             | Open sessions and focus AI pane                |
| `Tab`               | Open sessions and stay in sidebar              |
| `c`                 | Close panes for selected folder (confirm)      |
| `x`                 | Restart dead panes for selected folder         |
| `i`                 | Toggle AI pane (shell-only mode)               |
| `g`                 | Open GitHub PR in browser                      |
| `a`                 | Add a new repo                                 |
| `Backspace`         | Remove repo from config (with confirm)         |
| `o`                 | Open config file in system file browser        |
| `w`                 | Add git worktree (worktree repos only)         |
| `d`                 | Delete worktree (worktree repos only)          |
| `?`                 | Show help                                      |
| `Alt+S`             | Open settings                                  |
| `Ctrl+K`            | Quit and kill the session (wipes claude state) |

**Text selection:** Hold `Shift` while clicking and dragging to select text (bypasses tmux mouse mode). On macOS Terminal.app, use `fn` instead.

### Sidebar structure

The sidebar shows repos from your config file. Repos with git worktrees display as a tree:

```
standalone-repo      <-- repo without worktrees (selectable)
my-project           <-- repo header (not selectable)
  *- dev             <-- worktree (selectable)
  -- feature-branch  <-- worktree (selectable)
```

Plain repos are sorted alphabetically at the top, followed by worktree repos sorted alphabetically.

Status indicators before each name: `[AI][Shell]`

-   spinner (green) — busy (recent output)
-   `-` (grey) — idle
-   `x` (red) — exited
-   blank — no session

After the name:

-   `*` — uncommitted changes
-   `+` — unpushed commits
-   underlined — has an open GitHub PR (press `g` to open)

### GitHub PR integration

If [`gh`](https://cli.github.com/) (GitHub CLI) is installed and authenticated, agent-storm checks every 60 seconds whether each branch has an open pull request. Branches with PRs are underlined in the sidebar. Press `g` to open the PR in your browser.

This feature is optional: if `gh` is not installed or not authenticated, PR checks are silently skipped. If `gh` is available but errors occur, the check interval backs off exponentially (up to ~16 minutes) and errors are logged to the [log file](#logs).

### Sessions

Sessions persist when you switch between folders. Select a folder you've already opened and the previous AI and shell sessions are still there.

If a pane's process exits (e.g. `/exit` in Claude), the pane stays visible with its output. Press `x` to restart dead panes.

### Config

Settings are stored in `~/.config/agent-storm.toml`:

```toml
ai_cmd = "claude"
post_worktree_cmd = "npm install"
auto_update = true

[[repos]]
path = "/Users/you/repos/my-project"
post_worktree_cmd = "npm ci && npm run init"

[[repos]]
path = "/Users/you/repos/other-project"
```

-   `ai_cmd` — command to run in the AI pane (default: `claude`)
-   `post_worktree_cmd` — global default command to run after creating a worktree
-   `auto_update` — automatically check for and install updates in the background (default: `true`). When enabled, agent-storm checks GitHub for new releases once per hour and installs them silently. An orange "restart to update" banner appears in the sidebar when an update has been downloaded.
-   `repos` — list of repos to browse, each with an optional per-repo `post_worktree_cmd`
-   `hidden_ai_pane` — list of folder paths where the AI pane is hidden (toggled with `i` in the sidebar)

CLI flags (`--ai-cmd`, `--post-worktree-cmd`) override config values.

### Git worktree support

Point agent-storm at the parent directory that contains your worktree folders:

```
my-project/              <-- this path goes in repos
  my-project.git/        <-- bare repo (auto-hidden)
  dev/                   <-- worktree
  feature-branch/        <-- worktree
```

When adding a repo (via `ags --add`, the `a` sidebar command, or the first-run prompt), agent-storm automatically detects if the path is inside a git worktree and adds the worktree root instead.

Worktree features:

-   Bare repo directories are hidden from the sidebar
-   `w` to create a new worktree (runs `post_worktree_cmd` after creation)
-   `d` to delete a worktree (with confirmation, blocked for the last worktree)

### Logs

Background update errors are logged to the system temp directory:

-   macOS/Linux: `/tmp/agent-storm.log`
