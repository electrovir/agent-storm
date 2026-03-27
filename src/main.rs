mod app;
mod input;
mod pane;
mod ui;
mod worktree;

use app::App;
use clap::Parser;
use std::env;
use std::io;
use std::panic;

#[derive(Parser)]
#[command(name = "agent-storm", about = "Multi-pane AI coding assistant launcher")]
struct Cli {
    /// Command to run in the AI pane (middle column).
    #[arg(long, default_value = "claude")]
    ai_cmd: String,
}

#[tokio::main]
async fn main() -> io::Result<()> {
    let cli = Cli::parse();

    // Ensure the terminal is restored on panic.
    let default_hook = panic::take_hook();
    panic::set_hook(Box::new(move |info| {
        let _ = ratatui::restore();
        default_hook(info);
    }));

    let cwd = env::current_dir()?;
    let mut app = App::new(cwd, cli.ai_cmd);

    let mut terminal = ratatui::init();
    let result = app.run(&mut terminal).await;
    ratatui::restore();

    result
}
