use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub struct TmuxSession {
    pub ai_pane_id: Option<String>,
    pub shell_pane_id: String,
}

struct CachedPaneInfo {
    dead: bool,
    activity: u64,
    current_command: String,
}

const SHELL_COMMANDS: &[&str] = &["zsh", "bash", "fish", "sh", "dash", "tcsh", "csh", "ksh"];

pub struct TmuxController {
    session_name: String,
    sidebar_pane_id: String,
    sessions: HashMap<PathBuf, TmuxSession>,
    active_folder: Option<PathBuf>,
    ai_cmd: String,
    pane_info: HashMap<String, CachedPaneInfo>,
    last_pane_refresh: Instant,
}

impl TmuxController {
    pub fn new(session_name: String, ai_cmd: String) -> Self {
        let sidebar_pane_id = std::env::var("TMUX_PANE").unwrap_or_else(|_| "%0".to_string());
        TmuxController {
            session_name,
            sidebar_pane_id,
            sessions: HashMap::new(),
            active_folder: None,
            ai_cmd,
            pane_info: HashMap::new(),
            last_pane_refresh: Instant::now(),
        }
    }

    pub fn active_folder(&self) -> Option<&PathBuf> {
        self.active_folder.as_ref()
    }

    pub fn focus_sidebar(&self) {
        focus_pane(&self.sidebar_pane_id);
    }

    pub fn session_for(&self, folder: &Path) -> Option<&TmuxSession> {
        self.sessions.get(folder)
    }

    /// Set up initial tmux session options and keybindings.
    pub fn setup_session(&self) {
        let s = &self.session_name;

        tmux_cmd(&["set-option", "-t", s, "-g", "status", "off"]);
        tmux_cmd(&["set-option", "-t", s, "-g", "mouse", "on"]);
        tmux_cmd(&["set-option", "-t", s, "-g", "set-titles", "on"]);
        tmux_cmd(&["set-option", "-t", s, "-g", "set-titles-string", "agent-storm"]);
        tmux_cmd(&["set-option", "-t", s, "-g", "remain-on-exit", "on"]);
        tmux_cmd(&["set-option", "-t", s, "-g", "pane-border-lines", "heavy"]);
        tmux_cmd(&["set-option", "-t", s, "-g", "pane-border-style", "fg=colour24"]);
        tmux_cmd(&["set-option", "-t", s, "-g", "pane-active-border-style", "fg=colour39,bold"]);
        // Dim inactive panes so the focused pane stands out.  The dimmed color
        // is detected from the real terminal before tmux launches and passed via
        // env var; skip if detection failed.
        if let Ok(dim_bg) = std::env::var("_AGENT_STORM_DIM_BG") {
            tmux_cmd(&["set-option", "-t", s, "-g", "window-style", &format!("bg={dim_bg}")]);
            tmux_cmd(&["set-option", "-t", s, "-g", "window-active-style", "bg=terminal"]);
        }

        // Keybindings (use -n so they work without prefix from any pane).
        tmux_cmd(&[
            "bind-key", "-n", "M-1", "select-pane", "-t", &self.sidebar_pane_id,
        ]);
        tmux_cmd(&["bind-key", "-n", "C-q", "kill-session"]);
        tmux_cmd(&["bind-key", "-n", "M-f", "resize-pane", "-Z"]);
        tmux_cmd(&[
            "bind-key", "-n", "M-k", "run-shell", "tmux clear-history",
        ]);
    }

    /// Activate a folder: create or restore its AI and shell panes.
    /// If `keep_sidebar_focus` is true, focus stays on the sidebar.
    /// If `hide_ai` is true, only the shell pane is created/shown.
    pub fn activate_folder(
        &mut self,
        folder: &PathBuf,
        keep_sidebar_focus: bool,
        hide_ai: bool,
    ) -> Result<(), String> {
        // Park current panes if switching folders.
        if let Some(current) = &self.active_folder.clone() {
            if current == folder {
                if !keep_sidebar_focus
                    && let Some(session) = self.sessions.get(folder)
                {
                    let focus_id = session
                        .ai_pane_id
                        .as_deref()
                        .unwrap_or(&session.shell_pane_id);
                    focus_pane(focus_id);
                }
                return Ok(());
            }
            self.park_current_panes();
        }

        if self.sessions.contains_key(folder) {
            self.restore_panes(folder)?;
        } else {
            self.create_panes(folder, hide_ai)?;
        }

        // Reconcile AI pane state with hide_ai preference.
        self.reconcile_ai_pane(folder, hide_ai);

        self.active_folder = Some(folder.clone());
        self.update_keybindings();
        self.fix_layout();

        let folder_name = folder
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("?");
        self.set_title(folder_name);

        if !keep_sidebar_focus
            && let Some(session) = self.sessions.get(folder)
        {
            let focus_id = session
                .ai_pane_id
                .as_deref()
                .unwrap_or(&session.shell_pane_id);
            focus_pane(focus_id);
        } else if keep_sidebar_focus {
            focus_pane(&self.sidebar_pane_id);
        }

        Ok(())
    }

    fn create_panes(&mut self, folder: &Path, hide_ai: bool) -> Result<(), String> {
        let folder = std::fs::canonicalize(folder)
            .map_err(|e| format!("Folder does not exist: {e}"))?;
        let folder_str = folder.to_str().ok_or("Invalid folder path.")?;

        let ai_pane_id = if hide_ai {
            None
        } else {
            // Create AI pane to the right of sidebar.
            Some(
                tmux_cmd_output(&[
                    "split-window",
                    "-h",
                    "-t",
                    &self.sidebar_pane_id,
                    "-c",
                    folder_str,
                    "-P",
                    "-F",
                    "#{pane_id}",
                    &self.ai_cmd,
                ])
                .map_err(|e| format!("Failed to create AI pane: {e}"))?,
            )
        };

        // Create shell pane to the right of AI (or sidebar if AI is hidden).
        let split_target = ai_pane_id
            .as_deref()
            .unwrap_or(&self.sidebar_pane_id);
        let shell_pane_id = tmux_cmd_output(&[
            "split-window",
            "-h",
            "-t",
            split_target,
            "-c",
            folder_str,
            "-P",
            "-F",
            "#{pane_id}",
        ])
        .map_err(|e| format!("Failed to create shell pane: {e}"))?;

        self.sessions.insert(
            folder.to_path_buf(),
            TmuxSession {
                ai_pane_id,
                shell_pane_id,
            },
        );

        Ok(())
    }

    fn park_current_panes(&mut self) {
        let Some(folder) = &self.active_folder.clone() else {
            return;
        };
        let Some(session) = self.sessions.get(folder) else {
            return;
        };

        // Move panes to background windows. Park shell first (rightmost).
        tmux_cmd(&["break-pane", "-d", "-s", &session.shell_pane_id]);
        if let Some(ai_id) = &session.ai_pane_id {
            tmux_cmd(&["break-pane", "-d", "-s", ai_id]);
        }
    }

    fn restore_panes(&self, folder: &PathBuf) -> Result<(), String> {
        let session = self
            .sessions
            .get(folder)
            .ok_or("No session for folder.")?;

        if let Some(ai_id) = &session.ai_pane_id {
            // Join AI pane to the right of sidebar.
            tmux_cmd(&[
                "join-pane",
                "-h",
                "-s",
                ai_id,
                "-t",
                &self.sidebar_pane_id,
            ]);

            // Join shell pane to the right of AI.
            tmux_cmd(&[
                "join-pane",
                "-h",
                "-s",
                &session.shell_pane_id,
                "-t",
                ai_id,
            ]);
        } else {
            // No AI pane — join shell directly to the right of sidebar.
            tmux_cmd(&[
                "join-pane",
                "-h",
                "-s",
                &session.shell_pane_id,
                "-t",
                &self.sidebar_pane_id,
            ]);
        }

        Ok(())
    }

    fn fix_layout(&self) {
        // Set sidebar to fixed width.
        tmux_cmd(&[
            "resize-pane",
            "-t",
            &self.sidebar_pane_id,
            "-x",
            "30",
        ]);
        // Give the AI pane 40% of the remaining space (shell gets 60%).
        if let Some(folder) = &self.active_folder
            && let Some(session) = self.sessions.get(folder)
            && let Some(ai_id) = &session.ai_pane_id
        {
            tmux_cmd(&[
                "resize-pane",
                "-t",
                ai_id,
                "-x",
                "40%",
            ]);
        }
    }

    fn update_keybindings(&self) {
        if let Some(folder) = &self.active_folder
            && let Some(session) = self.sessions.get(folder)
        {
            let alt2_target = session
                .ai_pane_id
                .as_deref()
                .unwrap_or(&session.shell_pane_id);
            tmux_cmd(&[
                "bind-key",
                "-n",
                "M-2",
                "select-pane",
                "-t",
                alt2_target,
            ]);
            tmux_cmd(&[
                "bind-key",
                "-n",
                "M-3",
                "select-pane",
                "-t",
                &session.shell_pane_id,
            ]);
        }
    }

    /// Remove a folder's session and kill its panes (and their process trees).
    pub fn remove_session(&mut self, folder: &PathBuf) {
        if let Some(session) = self.sessions.remove(folder) {
            if let Some(ai_id) = &session.ai_pane_id {
                kill_pane(ai_id);
            }
            kill_pane(&session.shell_pane_id);
        }
        if self.active_folder.as_ref() == Some(folder) {
            self.active_folder = None;
        }
    }

    /// Send keys to a pane (e.g., post-worktree command to shell).
    pub fn send_keys_to_shell(&self, folder: &PathBuf, keys: &str) {
        if let Some(session) = self.sessions.get(folder) {
            tmux_cmd(&["send-keys", "-t", &session.shell_pane_id, keys, "Enter"]);
        }
    }

    /// Check if the sidebar pane is currently focused.
    pub fn is_sidebar_focused(&self) -> bool {
        tmux_cmd_output(&[
            "display-message",
            "-p",
            "-t",
            &self.sidebar_pane_id,
            "#{pane_active}",
        ])
        .map(|s| s == "1")
        .unwrap_or(true)
    }

    /// Refresh cached pane info from tmux. Throttled to avoid excess subprocess calls.
    pub fn refresh_pane_info(&mut self) {
        if self.last_pane_refresh.elapsed() < Duration::from_millis(200) {
            return;
        }
        self.last_pane_refresh = Instant::now();

        let Ok(output) = tmux_cmd_output(&[
            "list-panes",
            "-s",
            "-F",
            "#{pane_id}\t#{pane_dead}\t#{pane_current_command}\t#{pane_tty}",
        ]) else {
            return;
        };

        self.pane_info.clear();
        for line in output.lines() {
            let parts: Vec<&str> = line.split('\t').collect();
            if parts.len() >= 4 {
                let activity = tty_mtime_secs(parts[3]);
                self.pane_info.insert(
                    parts[0].to_string(),
                    CachedPaneInfo {
                        dead: parts[1] != "0",
                        activity,
                        current_command: parts[2].to_string(),
                    },
                );
            }
        }
    }

    /// Check if a pane is "busy".
    /// For shell panes (`is_shell_pane = true`): busy when the foreground process is not a shell.
    /// For AI panes: busy when the pane had recent output (within threshold).
    pub fn is_pane_busy(&self, pane_id: &str, threshold_secs: u64, is_shell_pane: bool) -> bool {
        let Some(info) = self.pane_info.get(pane_id) else {
            return false;
        };

        if is_shell_pane {
            let cmd = info.current_command.as_str();
            !SHELL_COMMANDS.contains(&cmd)
        } else {
            let now = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs();
            now.saturating_sub(info.activity) < threshold_secs
        }
    }

    /// Check if a pane's process is still running (not exited).
    pub fn is_pane_alive(&self, pane_id: &str) -> bool {
        self.pane_info
            .get(pane_id)
            .map(|info| !info.dead)
            .unwrap_or(false)
    }

    /// Respawn dead panes for a folder. Returns how many were restarted.
    pub fn respawn_dead_panes(&self, folder: &Path) -> usize {
        let Some(session) = self.sessions.get(folder) else {
            return 0;
        };
        let mut count = 0;
        if let Some(ai_id) = &session.ai_pane_id
            && !self.is_pane_alive(ai_id)
        {
            tmux_cmd(&["respawn-pane", "-t", ai_id]);
            count += 1;
        }
        if !self.is_pane_alive(&session.shell_pane_id) {
            tmux_cmd(&["respawn-pane", "-t", &session.shell_pane_id]);
            count += 1;
        }
        count
    }

    /// Ensure the AI pane state matches the `hide_ai` preference.
    fn reconcile_ai_pane(&mut self, folder: &Path, hide_ai: bool) {
        let Some(session) = self.sessions.get(folder) else {
            return;
        };
        if hide_ai && session.ai_pane_id.is_some() {
            let ai_id = self
                .sessions
                .get_mut(folder)
                .and_then(|s| s.ai_pane_id.take());
            if let Some(ai_id) = ai_id {
                kill_pane(&ai_id);
            }
        } else if !hide_ai && session.ai_pane_id.is_none() {
            let folder_str = folder.to_str().unwrap_or(".").to_string();
            let shell_id = session.shell_pane_id.clone();
            if let Ok(ai_id) = tmux_cmd_output(&[
                "split-window",
                "-h",
                "-b",
                "-t",
                &shell_id,
                "-c",
                &folder_str,
                "-P",
                "-F",
                "#{pane_id}",
                &self.ai_cmd,
            ])
                && let Some(session) = self.sessions.get_mut(folder)
            {
                session.ai_pane_id = Some(ai_id);
            }
        }
    }

    /// Hide the AI pane for a folder. Kills the AI pane and its processes.
    pub fn hide_ai_pane(&mut self, folder: &Path) {
        let ai_id = self
            .sessions
            .get_mut(folder)
            .and_then(|s| s.ai_pane_id.take());
        if let Some(ai_id) = ai_id {
            kill_pane(&ai_id);
        }
        if self.active_folder.as_deref() == Some(folder) {
            self.update_keybindings();
            self.fix_layout();
        }
    }

    /// Show the AI pane for a folder. Creates the pane if the folder is active.
    pub fn show_ai_pane(&mut self, folder: &Path) {
        let is_active = self.active_folder.as_deref() == Some(folder);
        if !is_active {
            return;
        }

        let folder_str = folder.to_str().unwrap_or(".").to_string();
        let shell_id = match self.sessions.get(folder) {
            Some(session) => session.shell_pane_id.clone(),
            None => return,
        };

        // Create AI pane before (to the left of) the shell pane.
        let Ok(ai_id) = tmux_cmd_output(&[
            "split-window",
            "-h",
            "-b",
            "-t",
            &shell_id,
            "-c",
            &folder_str,
            "-P",
            "-F",
            "#{pane_id}",
            &self.ai_cmd,
        ]) else {
            return;
        };

        if let Some(session) = self.sessions.get_mut(folder) {
            session.ai_pane_id = Some(ai_id);
        }
        self.update_keybindings();
        self.fix_layout();
    }

    /// Kill the entire tmux session.
    pub fn kill_session(&self) {
        tmux_cmd(&["kill-session", "-t", &self.session_name]);
    }

    pub fn set_title(&self, folder_name: &str) {
        let title = format!("agent-storm : {folder_name}");
        tmux_cmd(&["set-option", "-g", "set-titles-string", &title]);
    }

    pub fn set_ai_cmd(&mut self, cmd: String) {
        self.ai_cmd = cmd;
    }

    /// Zoom the sidebar pane to fullscreen.
    pub fn zoom_sidebar(&self) {
        tmux_cmd(&["resize-pane", "-Z", "-t", &self.sidebar_pane_id]);
    }

    /// Unzoom the sidebar pane back to normal layout.
    pub fn unzoom_sidebar(&self) {
        let zoomed = tmux_cmd_output(&[
            "display-message", "-p", "-t", &self.sidebar_pane_id, "#{window_zoomed_flag}",
        ])
        .map(|s| s == "1")
        .unwrap_or(false);
        if zoomed {
            tmux_cmd(&["resize-pane", "-Z", "-t", &self.sidebar_pane_id]);
        }
    }
}

/// Kill a tmux pane and all processes running inside it.
///
/// Plain `kill-pane` only sends SIGHUP to the direct child, which may leave
/// grandchild processes (e.g. `claude` sub-processes) running as orphans.
/// This helper first discovers the pane's root PID, walks the full descendant
/// tree, and sends SIGTERM to every process before destroying the pane.
fn kill_pane(pane_id: &str) {
    // 1. Grab the root PID that tmux launched in this pane.
    if let Ok(pid_str) = tmux_cmd_output(&[
        "display-message", "-p", "-t", pane_id, "#{pane_pid}",
    ]) {
        if let Ok(root_pid) = pid_str.parse::<u32>() {
            // Collect every descendant PID (children, grandchildren, …).
            let mut pids = Vec::new();
            collect_descendant_pids(root_pid, &mut pids);
            // Include the root process itself.
            pids.push(root_pid);

            // Send SIGTERM to each process (leaf-first so parents don't
            // respawn children before we get to them).
            for &pid in pids.iter().rev() {
                let _ = Command::new("kill")
                    .args(["-s", "TERM", &pid.to_string()])
                    .output();
            }
        }
    }

    // 2. Destroy the tmux pane itself.
    tmux_cmd(&["kill-pane", "-t", pane_id]);
}

/// Recursively collect all descendant PIDs of `parent`.
fn collect_descendant_pids(parent: u32, out: &mut Vec<u32>) {
    // `pgrep -P <pid>` lists direct children.
    let Ok(output) = Command::new("pgrep")
        .args(["-P", &parent.to_string()])
        .output()
    else {
        return;
    };
    let stdout = String::from_utf8_lossy(&output.stdout);
    for line in stdout.lines() {
        if let Ok(child_pid) = line.trim().parse::<u32>() {
            collect_descendant_pids(child_pid, out);
            out.push(child_pid);
        }
    }
}

fn tmux_cmd(args: &[&str]) {
    let _ = Command::new("tmux").args(args).output();
}

fn tmux_cmd_output(args: &[&str]) -> Result<String, String> {
    let output = Command::new("tmux")
        .args(args)
        .output()
        .map_err(|e| format!("Failed to run tmux: {e}"))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("tmux error: {stderr}"))
    }
}

fn focus_pane(pane_id: &str) {
    tmux_cmd(&["select-pane", "-t", pane_id]);
}

/// Check if tmux is available on PATH.
pub fn is_tmux_available() -> bool {
    Command::new("tmux")
        .arg("-V")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Read the modification time of a TTY device as seconds since UNIX epoch.
/// Falls back to 0 on any error.
fn tty_mtime_secs(tty: &str) -> u64 {
    std::fs::metadata(tty)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Compute a session name from the base directory.
pub fn session_name(base_dir: &Path) -> String {
    let hash = base_dir
        .to_str()
        .map(|s| {
            let mut h: u64 = 5381;
            for b in s.bytes() {
                h = h.wrapping_mul(33).wrapping_add(b as u64);
            }
            h
        })
        .unwrap_or(0);
    format!("ags-{hash:x}")
}
