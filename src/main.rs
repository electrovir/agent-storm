mod app;
mod config;
mod pane;
mod tmux;
mod ui;
mod worktree;

use app::App;
use clap::Parser;
use std::env;
use std::io;
use std::panic;
use std::path::PathBuf;
use std::process::Command;

#[derive(Parser)]
#[command(name = "agent-storm", about = "Multi-pane AI coding assistant launcher")]
struct Cli {
    /// Command to run in the AI pane (middle column). Overrides config file.
    #[arg(long)]
    ai_cmd: Option<String>,

    /// Command to run in the shell pane after creating a new worktree.
    #[arg(long)]
    post_worktree_cmd: Option<String>,

    /// Directory to browse. Defaults to the current working directory.
    cwd: Option<PathBuf>,

    /// Internal flag: run as the sidebar inside tmux. Do not use directly.
    #[arg(long, hide = true)]
    internal_sidebar: bool,
}

fn main() -> io::Result<()> {
    let cli = Cli::parse();

    let cfg = config::load_config();
    let ai_cmd = cli.ai_cmd.clone().unwrap_or(cfg.ai_cmd);
    let post_worktree_cmd = cli.post_worktree_cmd.clone().or(cfg.post_worktree_cmd);

    let base_dir = match &cli.cwd {
        Some(path) => std::fs::canonicalize(path)?,
        None => env::current_dir()?,
    };

    if cli.internal_sidebar {
        // We're inside tmux — run the ratatui sidebar.
        run_sidebar(base_dir, ai_cmd, post_worktree_cmd)
    } else {
        // Launch tmux and re-exec as sidebar inside it.
        launch_tmux(base_dir, ai_cmd, &cli)
    }
}

fn launch_tmux(base_dir: PathBuf, ai_cmd: String, cli: &Cli) -> io::Result<()> {
    if !tmux::is_tmux_available() {
        eprintln!("Error: tmux is required but not found. Install it with:");
        eprintln!("  macOS:  brew install tmux");
        eprintln!("  Linux:  sudo apt install tmux");
        eprintln!();
        eprintln!("https://github.com/tmux/tmux/wiki/Installing");
        std::process::exit(1);
    }

    let session_name = tmux::session_name(&base_dir);

    // Check if session already exists — just attach.
    let existing = Command::new("tmux")
        .args(["has-session", "-t", &session_name])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);

    if existing {
        let status = Command::new("tmux")
            .args(["attach-session", "-t", &session_name])
            .status()?;
        std::process::exit(status.code().unwrap_or(0));
    }

    // Build the sidebar command with forwarded args.
    let exe = env::current_exe()?;
    let mut sidebar_cmd = format!(
        "{} --internal-sidebar --ai-cmd '{}'",
        exe.display(),
        ai_cmd.replace('\'', "'\\''")
    );
    if let Some(ref cmd) = cli.post_worktree_cmd {
        sidebar_cmd.push_str(&format!(
            " --post-worktree-cmd '{}'",
            cmd.replace('\'', "'\\''")
        ));
    }
    // Positional cwd arg must come last.
    if let Some(ref cwd) = cli.cwd {
        sidebar_cmd.push_str(&format!(
            " '{}'",
            cwd.display().to_string().replace('\'', "'\\''")
        ));
    }

    // Create tmux session running the sidebar.
    let dir_name = base_dir
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("unknown");

    let status = Command::new("tmux")
        .args([
            "new-session",
            "-s",
            &session_name,
            "-n",
            &format!("ags : {dir_name}"),
            &sidebar_cmd,
        ])
        .status()?;

    std::process::exit(status.code().unwrap_or(0));
}

fn run_sidebar(
    base_dir: PathBuf,
    ai_cmd: String,
    post_worktree_cmd: Option<String>,
) -> io::Result<()> {
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    let result = rt.block_on(async_sidebar(base_dir, ai_cmd, post_worktree_cmd));
    rt.shutdown_timeout(std::time::Duration::from_millis(500));
    result
}

async fn async_sidebar(
    base_dir: PathBuf,
    ai_cmd: String,
    post_worktree_cmd: Option<String>,
) -> io::Result<()> {
    // Ensure the terminal is restored on panic.
    let default_hook = panic::take_hook();
    panic::set_hook(Box::new(move |info| {
        ratatui::restore();
        default_hook(info);
    }));

    let mut app = App::new(base_dir, ai_cmd, post_worktree_cmd);

    let mut terminal = ratatui::init();
    let result = app.run(&mut terminal).await;
    ratatui::restore();

    // Kill the tmux session on exit.
    app.kill_tmux_session();

    result
}
