mod app;
mod config;
mod pane;
mod tmux;
mod ui;
mod updater;
mod worktree;

use app::App;
use clap::Parser;
use std::env;
use std::io;
use std::os::unix::io::AsRawFd;
use std::panic;
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Parser)]
#[command(name = "agent-storm", version, about = "Multi-pane AI coding assistant launcher")]
struct Cli {
    /// Command to run in the AI pane (middle column). Overrides config file.
    #[arg(long)]
    ai_cmd: Option<String>,

    /// Command to run in the shell pane after creating a new worktree.
    #[arg(long)]
    post_worktree_cmd: Option<String>,

    /// Directory to browse. Defaults to the current working directory.
    cwd: Option<PathBuf>,

    /// Add the given path (or cwd) to the repos list in the config and exit.
    #[arg(long)]
    add: bool,

    /// Ignore the repos config; only browse the given path (or cwd).
    #[arg(long)]
    lone: bool,

    /// Open the config file in your terminal editor ($EDITOR) and exit.
    #[arg(long)]
    config: bool,

    /// Update agent-storm to the latest release from GitHub and exit.
    #[arg(long)]
    update: bool,

    /// Internal flag: run as the sidebar inside tmux. Do not use directly.
    #[arg(long, hide = true)]
    internal_sidebar: bool,

    /// Internal flag: lone mode passed through to sidebar.
    #[arg(long, hide = true)]
    internal_lone: bool,

    /// Internal flag: pending repo path to prompt about.
    #[arg(long, hide = true)]
    internal_pending_repo: Option<PathBuf>,
}

fn main() -> io::Result<()> {
    let cli = Cli::parse();

    let mut cfg = config::load_config();
    let ai_cmd = cli.ai_cmd.clone().unwrap_or(cfg.ai_cmd.clone());
    // CLI override for global post_worktree_cmd.
    if let Some(ref pwc) = cli.post_worktree_cmd {
        cfg.post_worktree_cmd = Some(pwc.clone());
    }

    let base_dir = match &cli.cwd {
        Some(path) => std::fs::canonicalize(path)?,
        None => env::current_dir()?,
    };

    // --config: open config in $EDITOR and exit.
    if cli.config {
        return open_config_in_editor();
    }

    // --update: download latest release and exit.
    if cli.update {
        return update_binary();
    }

    // --add: add repo to config and exit.
    if cli.add {
        return add_repo_cli(&base_dir);
    }

    // --lone: use only the given path, skip repo config entirely.
    let lone = cli.lone || cli.internal_lone;

    let mut pending_repo: Option<PathBuf> = None;

    if lone {
        let repo_path = worktree::resolve_repo_path(&base_dir);
        cfg.repos.clear();
        cfg.add_repo(repo_path, None);
    } else if !cli.internal_sidebar {
        let repo_path = worktree::resolve_repo_path(&base_dir);
        if repo_path.is_dir() && !cfg.has_repo(&repo_path) {
            if cfg.repos.is_empty() {
                // First run — auto-add, but still ask for post-worktree cmd via TUI.
                pending_repo = Some(repo_path);
            } else {
                // New path — ask via TUI dialog.
                pending_repo = Some(repo_path);
            }
        }
    }

    if cli.internal_sidebar {
        let pr = cli.internal_pending_repo.or(pending_repo);
        run_sidebar(cfg, ai_cmd, lone, pr)
    } else {
        // Launch tmux and re-exec as sidebar inside it.
        launch_tmux(base_dir, ai_cmd, &cli, pending_repo, cfg.border_style.as_deref())
    }
}

fn add_repo_cli(path: &Path) -> io::Result<()> {
    if !path.is_dir() {
        eprintln!("Error: {} is not a directory.", path.display());
        std::process::exit(1);
    }

    let repo_path = worktree::resolve_repo_path(path);

    let mut cfg = config::load_config();

    if cfg.has_repo(&repo_path) {
        eprintln!("{} is already in the repos list.", repo_path.display());
        std::process::exit(0);
    }

    println!("Adding {} to repos.", repo_path.display());
    let pwc = prompt_post_worktree_cmd(&repo_path);
    cfg.add_repo(repo_path, pwc);
    config::save_config(&cfg).map_err(io::Error::other)?;

    println!("Saved to {}", config::config_path_display());
    Ok(())
}

fn prompt_post_worktree_cmd(repo_path: &Path) -> Option<String> {
    eprint!(
        "Post-worktree command for {} (blank to skip): ",
        repo_path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("?")
    );
    let mut input = String::new();
    let _ = std::io::stdin().read_line(&mut input);
    let trimmed = input.trim().to_string();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

fn open_config_in_editor() -> io::Result<()> {
    let path = config::config_path_display();
    let editor = env::var("EDITOR").unwrap_or_else(|_| {
        if cfg!(target_os = "macos") {
            "nano".to_string()
        } else {
            "vi".to_string()
        }
    });
    let status = Command::new(&editor).arg(&path).status()?;
    std::process::exit(status.code().unwrap_or(0));
}

fn update_binary() -> io::Result<()> {
    eprintln!("Updating agent-storm...");

    match updater::check_and_apply_update(true) {
        Ok(tag) => {
            eprintln!("Updated to {tag}.");
            Ok(())
        }
        Err(msg) => {
            eprintln!("Error: {msg}");
            std::process::exit(1);
        }
    }
}

fn launch_tmux(
    base_dir: PathBuf,
    ai_cmd: String,
    cli: &Cli,
    pending_repo: Option<PathBuf>,
    border_style: Option<&str>,
) -> io::Result<()> {
    if !tmux::is_tmux_available() {
        eprintln!("Error: tmux is required but not found. Install it with:");
        eprintln!("  macOS:  brew install tmux");
        eprintln!("  Linux:  sudo apt install tmux");
        eprintln!();
        eprintln!("https://github.com/tmux/tmux/wiki/Installing");
        std::process::exit(1);
    }

    let session_name = tmux::session_name(&base_dir);

    // Kill any stale session with the same name.
    let _ = Command::new("tmux")
        .args(["kill-session", "-t", &session_name])
        .output();

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
    if cli.lone {
        sidebar_cmd.push_str(" --internal-lone");
    }
    if let Some(ref pr) = pending_repo {
        sidebar_cmd.push_str(&format!(
            " --internal-pending-repo '{}'",
            pr.display().to_string().replace('\'', "'\\''")
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

    let mut cmd = Command::new("tmux");
    cmd.args([
        "new-session",
        "-s",
        &session_name,
        "-n",
        &format!("ags : {dir_name}"),
        &sidebar_cmd,
    ]);

    // Detect the terminal's background color and pass a dimmed variant into
    // the tmux session so inactive panes can be visually distinguished.
    if let Some(dim_bg) = detect_dim_bg() {
        cmd.env("_AGENT_STORM_DIM_BG", dim_bg);
    }

    // Determine pane border style. VTE-based terminals (gnome-terminal, tilix,
    // etc.) often render heavy box-drawing characters as double-width, which
    // breaks the tmux layout. Auto-detect and fall back to "single".
    let border_style = resolve_border_style(border_style);
    cmd.env("_AGENT_STORM_BORDER_LINES", border_style);

    let status = cmd.status()?;

    std::process::exit(status.code().unwrap_or(0));
}

fn run_sidebar(
    cfg: config::Config,
    ai_cmd: String,
    lone: bool,
    pending_repo: Option<PathBuf>,
) -> io::Result<()> {
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    let result = rt.block_on(async_sidebar(cfg, ai_cmd, lone, pending_repo));
    rt.shutdown_timeout(std::time::Duration::from_millis(500));
    result
}

async fn async_sidebar(
    cfg: config::Config,
    ai_cmd: String,
    lone: bool,
    pending_repo: Option<PathBuf>,
) -> io::Result<()> {
    // Ensure the terminal is restored on panic.
    let default_hook = panic::take_hook();
    panic::set_hook(Box::new(move |info| {
        ratatui::restore();
        default_hook(info);
    }));

    let mut app = App::new(cfg, ai_cmd, lone, pending_repo);

    let mut terminal = ratatui::init();
    crossterm::execute!(io::stdout(), crossterm::event::EnableMouseCapture)?;
    let result = app.run(&mut terminal).await;
    crossterm::execute!(io::stdout(), crossterm::event::DisableMouseCapture)?;
    ratatui::restore();

    // Kill the tmux session on exit.
    app.kill_tmux_session();

    result
}

/// Resolve the tmux pane border line style. When the user has not set an
/// explicit style (or set "auto"), detect VTE-based terminals and fall back
/// to "single" borders to avoid double-width rendering of heavy characters.
fn resolve_border_style(configured: Option<&str>) -> &'static str {
    match configured {
        Some("auto") | None => {
            if env::var_os("VTE_VERSION").is_some() {
                "single"
            } else {
                "heavy"
            }
        }
        Some("heavy") => "heavy",
        Some("single") => "single",
        Some("double") => "double",
        Some("simple") => "simple",
        Some(_) => "heavy",
    }
}

/// Query the terminal for its background color via OSC 11 and return a
/// slightly dimmed variant as a `#RRGGBB` hex string suitable for tmux.
/// Returns `None` when the terminal does not respond (e.g. inside a pipe).
fn detect_dim_bg() -> Option<String> {
    use std::io::{Read, Write};

    let mut tty = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open("/dev/tty")
        .ok()?;
    let fd = tty.as_raw_fd();

    // Save terminal state.
    let mut saved: libc::termios = unsafe { std::mem::zeroed() };
    if unsafe { libc::tcgetattr(fd, &mut saved) } != 0 {
        return None;
    }

    // Switch to raw mode so we can read the response bytes directly.
    let mut raw = saved;
    unsafe { libc::cfmakeraw(&mut raw) };
    if unsafe { libc::tcsetattr(fd, libc::TCSANOW, &raw) } != 0 {
        return None;
    }

    // Send OSC 11 query ("what is the background color?").
    let ok = tty
        .write_all(b"\x1b]11;?\x07")
        .and_then(|_| tty.flush())
        .is_ok();
    if !ok {
        unsafe { libc::tcsetattr(fd, libc::TCSANOW, &saved) };
        return None;
    }

    // Read response with a timeout.
    let mut buf = [0u8; 64];
    let mut total = 0;
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(500);

    while total < buf.len() {
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        if remaining.is_zero() {
            break;
        }
        let mut pfd = libc::pollfd {
            fd,
            events: libc::POLLIN,
            revents: 0,
        };
        let timeout_ms = remaining.as_millis().min(500) as i32;
        if unsafe { libc::poll(&mut pfd, 1, timeout_ms) } <= 0 {
            break;
        }
        match tty.read(&mut buf[total..]) {
            Ok(0) => break,
            Ok(n) => {
                total += n;
                // Complete once we see BEL or ST terminator.
                if buf[..total].contains(&0x07)
                    || buf[..total].windows(2).any(|w| w == b"\x1b\\")
                {
                    break;
                }
            }
            Err(_) => break,
        }
    }

    // Always restore the terminal.
    unsafe { libc::tcsetattr(fd, libc::TCSANOW, &saved) };

    let response = String::from_utf8_lossy(&buf[..total]);
    let (r, g, b) = parse_osc_rgb(&response)?;

    // Perceived luminance (Rec. 709).
    let lum = 0.2126 * r as f64 + 0.7152 * g as f64 + 0.0722 * b as f64;
    let blend = 0.08;

    let (dr, dg, db) = if lum < 128.0 {
        // Dark background: lighten slightly.
        (
            (r as f64 + (255.0 - r as f64) * blend).round() as u8,
            (g as f64 + (255.0 - g as f64) * blend).round() as u8,
            (b as f64 + (255.0 - b as f64) * blend).round() as u8,
        )
    } else {
        // Light background: darken slightly.
        (
            (r as f64 * (1.0 - blend)).round() as u8,
            (g as f64 * (1.0 - blend)).round() as u8,
            (b as f64 * (1.0 - blend)).round() as u8,
        )
    };

    Some(format!("#{dr:02x}{dg:02x}{db:02x}"))
}

/// Parse an OSC 11 response like `\x1b]11;rgb:RRRR/GGGG/BBBB\x07` into 8-bit
/// RGB values. Handles 1-4 hex digits per channel.
fn parse_osc_rgb(response: &str) -> Option<(u8, u8, u8)> {
    let rgb_part = &response[response.find("rgb:")? + 4..];
    let mut parts = rgb_part.splitn(3, '/');

    let r_hex = parts.next()?;
    let g_hex = parts.next()?;
    let b_raw = parts.next()?;
    let b_hex: String = b_raw.chars().take_while(|c| c.is_ascii_hexdigit()).collect();

    Some((
        scale_hex_to_u8(r_hex)?,
        scale_hex_to_u8(g_hex)?,
        scale_hex_to_u8(&b_hex)?,
    ))
}

/// Convert a variable-length hex channel value to an 8-bit value.
fn scale_hex_to_u8(hex: &str) -> Option<u8> {
    let val = u16::from_str_radix(hex.trim(), 16).ok()?;
    match hex.trim().len() {
        1 => Some((val * 17) as u8),
        2 => Some(val as u8),
        3 => Some((val >> 4) as u8),
        4 => Some((val >> 8) as u8),
        _ => None,
    }
}
