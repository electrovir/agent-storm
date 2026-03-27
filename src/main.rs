mod app;
mod config;
mod input;
mod pane;
mod ui;
mod worktree;

use app::App;
use clap::Parser;
use std::env;
use std::io;
use std::io::Write;
use std::panic;
use std::path::PathBuf;

#[derive(Parser)]
#[command(name = "agent-storm", about = "Multi-pane AI coding assistant launcher")]
struct Cli {
    /// Command to run in the AI pane (middle column). Overrides config file.
    #[arg(long)]
    ai_cmd: Option<String>,

    /// Command to run in the shell pane after creating a new worktree.
    #[arg(long)]
    post_worktree_cmd: Option<String>,

    /// Disable mouse capture on startup (allows text selection, no click-to-focus).
    #[arg(long)]
    no_mouse: bool,

    /// Directory to browse. Defaults to the current working directory.
    #[arg(long, short = 'C')]
    cwd: Option<PathBuf>,
}

fn main() -> io::Result<()> {
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    let result = rt.block_on(async_main());
    // Shut down the runtime with a timeout so lingering blocking tasks
    // (PTY readers) don't prevent exit.
    rt.shutdown_timeout(std::time::Duration::from_millis(500));
    result
}

async fn async_main() -> io::Result<()> {
    let cli = Cli::parse();
    let cfg = config::load_config();

    // CLI flags override config file values.
    let ai_cmd = cli.ai_cmd.unwrap_or(cfg.ai_cmd);
    let post_worktree_cmd = cli.post_worktree_cmd.or(cfg.post_worktree_cmd);
    let no_mouse = cli.no_mouse || cfg.no_mouse;

    // Ensure the terminal is restored on panic.
    let default_hook = panic::take_hook();
    panic::set_hook(Box::new(move |info| {
        ratatui::restore();
        default_hook(info);
    }));

    let base_dir = match cli.cwd {
        Some(path) => std::fs::canonicalize(path)?,
        None => env::current_dir()?,
    };

    // Set terminal window + tab title to "ags : <basename>".
    // OSC 1 sets the icon/tab name, OSC 2 sets the window title.
    // Sending an empty OSC 7 clears the CWD prefix macOS Terminal prepends.
    let dir_name = base_dir
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("unknown");
    let title = format!("ags : {dir_name}");
    write!(
        io::stdout(),
        "\x1b]1;{title}\x07\x1b]2;{title}\x07\x1b]7;\x07"
    )?;

    let mut app = App::new(base_dir, ai_cmd, post_worktree_cmd, !no_mouse);

    if !no_mouse {
        crossterm::execute!(io::stdout(), crossterm::event::EnableMouseCapture)?;
    }
    let mut terminal = ratatui::init();
    let result = app.run(&mut terminal).await;
    ratatui::restore();
    crossterm::execute!(io::stdout(), crossterm::event::DisableMouseCapture)?;

    result
}
