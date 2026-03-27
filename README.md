# agent-storm

A terminal UI for managing multiple AI coding sessions across project folders. Three-pane layout: folder picker, AI assistant (Claude Code by default), and a shell — all in one screen. Powered by [tmux](https://github.com/tmux/tmux/wiki/Installing).

<img src="example.png" alt="agent-storm example" width="100%">

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
# Browse folders in the current directory
ags

# Browse a specific directory
ags ~/repos/my-project

# Use a custom AI command
ags --ai-cmd "claude --model sonnet"
```

### Run from source (without installing)

```sh
git clone https://github.com/electrovir/agent-storm.git
cd agent-storm
cargo run -- ~/repos/my-project
```

### Layout

```
| Folders       | AI              | Shell           |
| *- fast-work  |                 |                 |
| -- merging    |  Claude Code    |  zsh / bash     |
|    prod       |                 |                 |
|                                                   |
| ?:help  ^Q:quit                                   |
```

The folder sidebar is a ratatui TUI. The AI and shell panes are native tmux panes with full terminal features: scrollback, text selection, native cursor, Cmd+K clear.

### Keybindings

**Global (work from any pane — handled by tmux):**

| Key | Action |
|-----|--------|
| `Alt+1` / `Alt+2` / `Alt+3` | Focus folders / AI / shell pane |
| `Alt+F` | Zoom (fullscreen) the current pane |
| `Ctrl+Q` | Quit |

**Folder sidebar (when sidebar is focused):**

| Key | Action |
|-----|--------|
| `j` / `k` or arrows | Navigate folders |
| `Enter` | Open folder sessions and focus AI pane |
| `Tab` | Open folder sessions and stay in sidebar |
| `x` | Restart dead panes for selected folder |
| `r` | Rename selected folder (uses `git worktree move` for worktrees) |
| `w` | Add git worktree (only in worktree directories) |
| `d` | Delete selected worktree (with confirmation) |
| `?` | Show help |
| `Alt+S` | Open settings |

**AI and shell panes** are native tmux panes. Use your terminal's normal features: scroll with mouse wheel, select text, Cmd+K to clear, etc.

### Folder status indicators

Each folder shows two status characters before its name: `[AI][Shell]`

- spinner (green) — busy (produced output recently)
- `-` (grey) — idle (alive, waiting for input)
- `x` (red) — exited
- blank — no session

After the folder name:
- `*` — has uncommitted changes
- `+` — has unpushed commits

### Sessions

Sessions persist when you switch between folders. Select a folder you've already opened and the previous AI and shell sessions are still there (panes are parked in hidden tmux windows and restored when you switch back).

If a pane's process exits (e.g. `/exit` in Claude), the pane stays visible with its output. Press `x` on the folder to restart dead panes.

### Config

Settings are stored in `~/.config/agent-storm.toml`:

```toml
ai_cmd = "claude"
post_worktree_cmd = "npm install"
```

- `ai_cmd` — command to run in the AI pane (default: `claude`)
- `post_worktree_cmd` — command to run in the shell after creating a new worktree (optional)

CLI flags (`--ai-cmd`, `--post-worktree-cmd`) override config values.

### Git worktree support

Point agent-storm at the parent directory that contains your worktree folders. Each worktree should be an immediate child directory:

```
my-project/              <-- open agent-storm here
  my-project.git/        <-- bare repo (auto-hidden)
  dev/                   <-- worktree
  feature-branch/        <-- worktree
```

```sh
ags ~/repos/my-project
```

When the directory contains git worktrees, agent-storm detects this automatically:

- Bare repo directories are hidden from the folder list
- Folders with uncommitted changes show a `*` indicator, unpushed commits show `+`
- Press `w` to create a new worktree
- Press `d` to delete a worktree (with confirmation)
- The `post_worktree_cmd` runs in the shell after creation (e.g. `npm install`)
