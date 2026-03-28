use crossterm::event::{self, Event, KeyCode, KeyModifiers};
use std::collections::HashMap;
use std::io;
use std::path::PathBuf;
use std::time::{Duration, Instant};
use tokio::sync::mpsc as tokio_mpsc;

use crate::config;
use crate::pane::folder_list::FolderList;
use crate::tmux::{self, TmuxController};
use crate::ui;
use crate::worktree;

enum BgMessage {
    StatusMessage(String),
    RefreshFolders,
    GitStatusResults(HashMap<PathBuf, crate::pane::folder_list::GitStatus>),
}

/// What the folder list input mode is doing.
#[derive(Clone, PartialEq, Eq)]
pub enum FolderMode {
    Normal,
    RenameInput { folder: PathBuf, buffer: String },
}

/// Which settings field is currently being edited.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum SettingsField {
    AiCmd,
    PostWorktreeCmd,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum AddRepoField {
    Path,
    PostWorktreeCmd,
}

/// Modal dialog state.
#[derive(Clone, PartialEq, Eq)]
pub enum Modal {
    None,
    Help,
    Settings {
        ai_cmd_buffer: String,
        post_worktree_cmd_buffer: String,
        active_field: SettingsField,
    },
    AddWorktree {
        buffer: String,
    },
    AddRepo {
        path_buffer: String,
        pwc_buffer: String,
        active_field: AddRepoField,
    },
    ConfirmDeleteWorktree {
        folder: PathBuf,
    },
    /// Prompt shown on startup when launching from a new repo path.
    ConfirmAddNewRepo {
        repo_path: PathBuf,
    },
    /// Follow-up after confirming add: ask for post-worktree command.
    NewRepoPostWorktreeCmd {
        repo_path: PathBuf,
        buffer: String,
    },
    ConfirmRemoveRepo {
        repo_path: PathBuf,
    },
    ConfirmClosePanes {
        folder: PathBuf,
    },
}

const STATUS_MESSAGE_TIMEOUT_SECS: u64 = 5;

pub struct App {
    folder_list: FolderList,
    tmux: TmuxController,
    should_quit: bool,
    ai_cmd: String,
    config: config::Config,
    lone: bool,
    folder_mode: FolderMode,
    status_message: Option<(String, Instant)>,
    modal: Modal,
    bg_sender: tokio_mpsc::UnboundedSender<BgMessage>,
    bg_receiver: tokio_mpsc::UnboundedReceiver<BgMessage>,
}

impl App {
    pub fn new(
        cfg: config::Config,
        ai_cmd: String,
        lone: bool,
        pending_repo: Option<PathBuf>,
    ) -> Self {
        let repo_paths = cfg.repo_paths();
        let session_base = repo_paths
            .first()
            .cloned()
            .unwrap_or_else(|| PathBuf::from("ags"));
        let session_name = tmux::session_name(&session_base);
        let tmux = TmuxController::new(session_name, ai_cmd.clone());
        tmux.setup_session();

        let (bg_sender, bg_receiver) = tokio_mpsc::unbounded_channel();

        App {
            folder_list: FolderList::new(repo_paths),
            tmux,
            should_quit: false,
            ai_cmd,
            config: cfg,
            lone,
            folder_mode: FolderMode::Normal,
            status_message: None,
            modal: match pending_repo {
                Some(repo_path) => Modal::ConfirmAddNewRepo { repo_path },
                None => Modal::None,
            },
            bg_sender,
            bg_receiver,
        }
    }

    pub fn folder_list(&self) -> &FolderList {
        &self.folder_list
    }

    pub fn config(&self) -> &config::Config {
        &self.config
    }

    pub fn is_lone(&self) -> bool {
        self.lone
    }

    pub fn tmux(&self) -> &TmuxController {
        &self.tmux
    }

    pub fn selected_is_worktree(&self) -> bool {
        self.folder_list.selected_is_worktree()
    }

    pub fn folder_mode(&self) -> &FolderMode {
        &self.folder_mode
    }

    pub fn status_message(&self) -> Option<&str> {
        match &self.status_message {
            Some((msg, set_at))
                if set_at.elapsed() < Duration::from_secs(STATUS_MESSAGE_TIMEOUT_SECS) =>
            {
                Some(msg.as_str())
            }
            _ => None,
        }
    }

    fn set_status(&mut self, msg: String) {
        self.status_message = Some((msg, Instant::now()));
    }

    pub fn modal(&self) -> &Modal {
        &self.modal
    }

    pub fn active_folder(&self) -> Option<&PathBuf> {
        self.tmux.active_folder()
    }

    pub async fn run(&mut self, terminal: &mut ratatui::DefaultTerminal) -> io::Result<()> {
        loop {
            // Spawn background dirty check if needed.
            if let Some((folders, in_flight)) = self.folder_list.maybe_start_dirty_check() {
                let sender = self.bg_sender.clone();
                tokio::task::spawn_blocking(move || {
                    let results = crate::pane::folder_list::check_git_status_all(&folders);
                    in_flight.store(false, std::sync::atomic::Ordering::SeqCst);
                    let _ = sender.send(BgMessage::GitStatusResults(results));
                });
            }

            terminal.draw(|frame| {
                ui::render(frame, self);
            })?;

            // Drain background task messages.
            while let Ok(msg) = self.bg_receiver.try_recv() {
                match msg {
                    BgMessage::StatusMessage(text) => self.set_status(text),
                    BgMessage::RefreshFolders => self.folder_list.refresh(),
                    BgMessage::GitStatusResults(results) => self.folder_list.apply_git_status(results),
                }
            }

            if event::poll(Duration::from_millis(1))? {
                match event::read()? {
                    Event::Key(key) => self.handle_key_event(key),
                    Event::Resize(_, _) => {
                        terminal.clear()?;
                    }
                    _ => {}
                }
            }
            tokio::task::yield_now().await;

            if self.should_quit {
                return Ok(());
            }
        }
    }

    pub fn kill_tmux_session(&self) {
        self.tmux.kill_session();
    }

    fn handle_key_event(&mut self, key: event::KeyEvent) {
        // Modal gets all input when open.
        if self.modal != Modal::None {
            self.handle_modal_key(key);
            return;
        }

        let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
        let alt = key.modifiers.contains(KeyModifiers::ALT);

        // Global bindings.
        if self.folder_mode == FolderMode::Normal {
            match key.code {
                KeyCode::Char('q') if ctrl => {
                    self.should_quit = true;
                    return;
                }
                KeyCode::Char('s') if alt => {
                    self.open_settings();
                    return;
                }
                KeyCode::Char('?') => {
                    self.modal = Modal::Help;
                    return;
                }
                _ => {}
            }
        }

        self.handle_folder_key(key);
    }

    fn open_settings(&mut self) {
        self.tmux.zoom_sidebar();
        self.modal = Modal::Settings {
            ai_cmd_buffer: self.ai_cmd.clone(),
            post_worktree_cmd_buffer: self.config.post_worktree_cmd.clone().unwrap_or_default(),
            active_field: SettingsField::AiCmd,
        };
    }

    fn close_modal(&mut self) {
        let was_zoomed = matches!(
            self.modal,
            Modal::Settings { .. } | Modal::AddWorktree { .. } | Modal::AddRepo { .. }
        );
        self.modal = Modal::None;
        if was_zoomed {
            self.tmux.unzoom_sidebar();
        }
    }

    fn handle_modal_key(&mut self, key: event::KeyEvent) {
        match &mut self.modal {
            Modal::None => {}
            Modal::Help => {
                // Any key dismisses the help modal.
                self.modal = Modal::None;
            }
            Modal::Settings {
                ai_cmd_buffer,
                post_worktree_cmd_buffer,
                active_field,
            } => match key.code {
                KeyCode::Esc => {
                    self.close_modal();
                }
                KeyCode::Tab | KeyCode::Up | KeyCode::Down => {
                    *active_field = match active_field {
                        SettingsField::AiCmd => SettingsField::PostWorktreeCmd,
                        SettingsField::PostWorktreeCmd => SettingsField::AiCmd,
                    };
                }
                KeyCode::Enter => {
                    let new_ai_cmd = ai_cmd_buffer.trim().to_string();
                    let new_post_worktree_cmd = post_worktree_cmd_buffer.trim().to_string();

                    if !new_ai_cmd.is_empty() {
                        self.ai_cmd = new_ai_cmd.clone();
                        self.tmux.set_ai_cmd(new_ai_cmd.clone());
                    }
                    self.config.post_worktree_cmd = if new_post_worktree_cmd.is_empty() {
                        None
                    } else {
                        Some(new_post_worktree_cmd.clone())
                    };

                    self.config.ai_cmd = self.ai_cmd.clone();
                    match config::save_config(&self.config) {
                        Ok(()) => {
                            self.set_status(format!(
                                "Saved to {}",
                                config::config_path_display()
                            ));
                        }
                        Err(err) => {
                            self.set_status(err);
                        }
                    }
                    self.close_modal();
                }
                KeyCode::Backspace => match active_field {
                    SettingsField::AiCmd => {
                        ai_cmd_buffer.pop();
                    }
                    SettingsField::PostWorktreeCmd => {
                        post_worktree_cmd_buffer.pop();
                    }
                },
                KeyCode::Char(c) => match active_field {
                    SettingsField::AiCmd => {
                        ai_cmd_buffer.push(c);
                    }
                    SettingsField::PostWorktreeCmd => {
                        post_worktree_cmd_buffer.push(c);
                    }
                },
                _ => {}
            },
            Modal::AddWorktree { buffer } => match key.code {
                KeyCode::Esc => {
                    self.close_modal();
                }
                KeyCode::Enter => {
                    let branch_name = buffer.trim().to_string();
                    self.close_modal();

                    if branch_name.is_empty() {
                        self.set_status("Cancelled (empty name).".to_string());
                        return;
                    }

                    let Some(existing) =
                        self.folder_list.selected_folder().map(|p| p.to_path_buf())
                    else {
                        self.set_status("No folder selected.".to_string());
                        return;
                    };

                    match worktree::add_worktree(&existing, &branch_name) {
                        Ok(msg) => {
                            self.set_status(msg);
                            self.folder_list.refresh();

                            let new_folder = existing.parent().map(|p| p.join(&branch_name));
                            if let Some(folder) = new_folder
                                && folder.is_dir()
                            {
                                if let Err(err) = self.tmux.activate_folder(&folder, false) {
                                    self.set_status(err);
                                } else {
                                    // Use per-repo command, falling back to global.
                                    let repo_parent = existing.parent().map(|p| p.to_path_buf());
                                    let cmd = repo_parent
                                        .as_ref()
                                        .and_then(|rp| self.config.post_worktree_cmd_for(rp))
                                        .cloned();
                                    if let Some(cmd) = cmd {
                                        self.tmux.send_keys_to_shell(&folder, &cmd);
                                    }
                                }
                            }
                        }
                        Err(msg) => {
                            self.set_status(msg);
                        }
                    }
                }
                KeyCode::Backspace => {
                    buffer.pop();
                }
                KeyCode::Char(c) => {
                    buffer.push(c);
                }
                _ => {}
            },
            Modal::AddRepo {
                path_buffer,
                pwc_buffer,
                active_field,
            } => match key.code {
                KeyCode::Esc => {
                    self.close_modal();
                }
                KeyCode::Tab | KeyCode::Up | KeyCode::Down => {
                    *active_field = match active_field {
                        AddRepoField::Path => AddRepoField::PostWorktreeCmd,
                        AddRepoField::PostWorktreeCmd => AddRepoField::Path,
                    };
                }
                KeyCode::Enter => {
                    let path_str = path_buffer.trim().to_string();
                    let pwc = pwc_buffer.trim().to_string();
                    self.close_modal();

                    if path_str.is_empty() {
                        self.set_status("Cancelled (empty path).".to_string());
                        return;
                    }

                    let expanded = if path_str.starts_with('~') {
                        dirs::home_dir()
                            .map(|h| h.join(path_str[1..].trim_start_matches('/')))
                            .unwrap_or_else(|| PathBuf::from(&path_str))
                    } else {
                        PathBuf::from(&path_str)
                    };

                    let path = match std::fs::canonicalize(&expanded) {
                        Ok(p) => p,
                        Err(err) => {
                            self.set_status(format!("Invalid path: {err}"));
                            return;
                        }
                    };

                    if !path.is_dir() {
                        self.set_status("Path is not a directory.".to_string());
                        return;
                    }

                    let path = worktree::resolve_repo_path(&path);

                    if self.config.has_repo(&path) {
                        self.set_status("Repo already in list.".to_string());
                        return;
                    }

                    let pwc_opt = if pwc.is_empty() { None } else { Some(pwc) };
                    self.config.add_repo(path, pwc_opt);
                    self.folder_list = FolderList::new(self.config.repo_paths());
                    match config::save_config(&self.config) {
                        Ok(()) => {
                            self.set_status(format!(
                                "Repo added. Saved to {}",
                                config::config_path_display()
                            ));
                        }
                        Err(err) => {
                            self.set_status(err);
                        }
                    }
                }
                KeyCode::Backspace => {
                    let buf = match active_field {
                        AddRepoField::Path => path_buffer,
                        AddRepoField::PostWorktreeCmd => pwc_buffer,
                    };
                    buf.pop();
                }
                KeyCode::Char(c) => {
                    let buf = match active_field {
                        AddRepoField::Path => path_buffer,
                        AddRepoField::PostWorktreeCmd => pwc_buffer,
                    };
                    buf.push(c);
                }
                _ => {}
            },
            Modal::ConfirmDeleteWorktree { folder } => {
                let folder = folder.clone();
                match key.code {
                    KeyCode::Char('y') | KeyCode::Char('Y') => {
                        self.modal = Modal::None;
                        self.delete_worktree(&folder);
                    }
                    KeyCode::Char('n') | KeyCode::Char('N') | KeyCode::Esc => {
                        self.modal = Modal::None;
                    }
                    _ => {}
                }
            }
            Modal::ConfirmAddNewRepo { repo_path } => {
                let repo_path = repo_path.clone();
                match key.code {
                    KeyCode::Char('y') | KeyCode::Char('Y') | KeyCode::Enter => {
                        // If repo has worktrees, ask for post-worktree command.
                        if worktree::is_worktree_root(&repo_path) {
                            self.modal = Modal::NewRepoPostWorktreeCmd {
                                repo_path,
                                buffer: String::new(),
                            };
                        } else {
                            self.config.add_repo(repo_path, None);
                            self.folder_list = FolderList::new(self.config.repo_paths());
                            let _ = config::save_config(&self.config);
                            self.set_status("Repo added.".to_string());
                            self.modal = Modal::None;
                        }
                    }
                    KeyCode::Char('n') | KeyCode::Char('N') | KeyCode::Esc => {
                        self.modal = Modal::None;
                    }
                    _ => {}
                }
            }
            Modal::NewRepoPostWorktreeCmd { repo_path, buffer } => {
                let repo_path = repo_path.clone();
                match key.code {
                    KeyCode::Esc => {
                        // Skip the command, still add the repo.
                        self.config.add_repo(repo_path, None);
                        self.folder_list = FolderList::new(self.config.repo_paths());
                        let _ = config::save_config(&self.config);
                        self.set_status("Repo added.".to_string());
                        self.modal = Modal::None;
                    }
                    KeyCode::Enter => {
                        let cmd = buffer.trim().to_string();
                        let pwc = if cmd.is_empty() { None } else { Some(cmd) };
                        self.config.add_repo(repo_path, pwc);
                        self.folder_list = FolderList::new(self.config.repo_paths());
                        let _ = config::save_config(&self.config);
                        self.set_status("Repo added.".to_string());
                        self.modal = Modal::None;
                    }
                    KeyCode::Backspace => {
                        buffer.pop();
                    }
                    KeyCode::Char(c) => {
                        buffer.push(c);
                    }
                    _ => {}
                }
            }
            Modal::ConfirmRemoveRepo { repo_path } => {
                let repo_path = repo_path.clone();
                match key.code {
                    KeyCode::Char('y') | KeyCode::Char('Y') | KeyCode::Enter => {
                        // Remove all sessions for worktrees under this repo.
                        let paths_to_remove: Vec<PathBuf> = self
                            .folder_list
                            .entries()
                            .iter()
                            .filter(|e| e.is_selectable())
                            .filter(|e| e.path().starts_with(&repo_path))
                            .map(|e| e.path().to_path_buf())
                            .collect();
                        for path in &paths_to_remove {
                            self.tmux.remove_session(&path.to_path_buf());
                        }

                        // Remove from config.
                        self.config.repos.retain(|r| r.path != repo_path);
                        let _ = config::save_config(&self.config);
                        self.folder_list = FolderList::new(self.config.repo_paths());
                        self.set_status("Repo removed.".to_string());
                        self.modal = Modal::None;
                    }
                    KeyCode::Char('n') | KeyCode::Char('N') | KeyCode::Esc => {
                        self.modal = Modal::None;
                    }
                    _ => {}
                }
            }
            Modal::ConfirmClosePanes { folder } => {
                let folder = folder.clone();
                match key.code {
                    KeyCode::Char('y') | KeyCode::Char('Y') => {
                        self.tmux.remove_session(&folder);
                        self.tmux.set_title("agent-storm");
                        self.tmux.focus_sidebar();
                        self.set_status("Panes closed.".to_string());
                        self.modal = Modal::None;
                    }
                    KeyCode::Char('n') | KeyCode::Char('N') | KeyCode::Esc => {
                        self.modal = Modal::None;
                    }
                    _ => {}
                }
            }
        }
    }

    fn delete_worktree(&mut self, folder: &PathBuf) {
        // Kill the tmux session for this folder.
        self.tmux.remove_session(folder);

        self.folder_list.refresh();
        self.set_status("Deleting worktree...".to_string());

        let sibling = self
            .folder_list
            .entries()
            .iter()
            .filter(|e| e.is_selectable() && e.path() != folder)
            .map(|e| e.path().to_path_buf())
            .next();

        let Some(sibling) = sibling else {
            self.set_status("No sibling worktree to run git from.".to_string());
            return;
        };

        let folder = folder.clone();
        let sender = self.bg_sender.clone();

        tokio::task::spawn_blocking(move || {
            match worktree::remove_worktree(&sibling, &folder) {
                Ok(msg) => {
                    let _ = sender.send(BgMessage::StatusMessage(msg));
                }
                Err(msg) => {
                    let _ = sender.send(BgMessage::StatusMessage(msg));
                }
            }
            let _ = sender.send(BgMessage::RefreshFolders);
        });
    }

    fn handle_folder_key(&mut self, key: event::KeyEvent) {
        match &self.folder_mode {
            FolderMode::Normal => self.handle_folder_normal_key(key),
            FolderMode::RenameInput { .. } => self.handle_rename_input_key(key),
        }
    }

    fn handle_folder_normal_key(&mut self, key: event::KeyEvent) {
        match key.code {
            KeyCode::Up | KeyCode::Char('k') => self.folder_list.move_up(),
            KeyCode::Down | KeyCode::Char('j') => self.folder_list.move_down(),
            KeyCode::Enter => self.activate_selected_folder_with_focus(true),
            KeyCode::Tab => self.activate_selected_folder_with_focus(false),
            KeyCode::Char('w') if self.selected_is_worktree() => {
                self.tmux.zoom_sidebar();
                self.modal = Modal::AddWorktree {
                    buffer: String::new(),
                };
            }
            KeyCode::Char('a') if !self.lone => {
                self.tmux.zoom_sidebar();
                self.modal = Modal::AddRepo {
                    path_buffer: String::new(),
                    pwc_buffer: String::new(),
                    active_field: AddRepoField::Path,
                };
            }
            KeyCode::Char('r') => {
                if let Some(folder) = self.folder_list.selected_folder().map(|p| p.to_path_buf()) {
                    let current_name = folder
                        .file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or("")
                        .to_string();
                    self.folder_mode = FolderMode::RenameInput {
                        folder,
                        buffer: current_name.clone(),
                    };
                    self.set_status(format!("Rename to: {current_name}"));
                }
            }
            KeyCode::Char('x') => {
                if let Some(folder) = self.folder_list.selected_folder().map(|p| p.to_path_buf()) {
                    let count = self.tmux.respawn_dead_panes(&folder);
                    if count > 0 {
                        self.set_status(format!("Restarted {count} dead pane(s)."));
                    } else {
                        self.set_status("No dead panes to restart.".to_string());
                    }
                }
            }
            KeyCode::Char('o') if !self.lone => {
                let path = config::config_path_display();
                let opener = if cfg!(target_os = "macos") {
                    "open"
                } else {
                    "xdg-open"
                };
                let _ = std::process::Command::new(opener).arg(&path).spawn();
                self.set_status(format!("Opened {path}"));
            }
            KeyCode::Char('d') if self.selected_is_worktree() => {
                if self.folder_list.selected_sibling_count() <= 1 {
                    self.set_status("Cannot delete the last worktree.".to_string());
                } else if let Some(folder) =
                    self.folder_list.selected_folder().map(|p| p.to_path_buf())
                {
                    self.modal = Modal::ConfirmDeleteWorktree { folder };
                }
            }
            KeyCode::Char('c') => {
                if let Some(folder) = self.folder_list.selected_folder().map(|p| p.to_path_buf()) {
                    if self.tmux.session_for(&folder).is_some() {
                        self.modal = Modal::ConfirmClosePanes { folder };
                    } else {
                        self.set_status("No panes open for this folder.".to_string());
                    }
                }
            }
            KeyCode::Backspace | KeyCode::Delete if !self.lone => {
                if let Some(repo_path) = self.folder_list.selected_repo_path() {
                    self.modal = Modal::ConfirmRemoveRepo { repo_path };
                }
            }
            _ => {}
        }
    }


    fn handle_rename_input_key(&mut self, key: event::KeyEvent) {
        let FolderMode::RenameInput { folder, buffer } = &mut self.folder_mode else {
            return;
        };

        match key.code {
            KeyCode::Esc => {
                self.folder_mode = FolderMode::Normal;
                self.status_message = None;
            }
            KeyCode::Enter => {
                let new_name = buffer.trim().to_string();
                let folder = folder.clone();
                self.folder_mode = FolderMode::Normal;

                if new_name.is_empty() {
                    self.set_status("Cancelled (empty name).".to_string());
                    return;
                }

                let old_name = folder
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("");
                if new_name == old_name {
                    self.set_status("Name unchanged.".to_string());
                    return;
                }

                match worktree::rename_folder(&folder, &new_name) {
                    Ok((msg, _new_path)) => {
                        self.set_status(msg);
                        self.folder_list.refresh();
                    }
                    Err(msg) => {
                        self.set_status(msg);
                    }
                }
            }
            KeyCode::Backspace => {
                buffer.pop();
                let msg = format!("Rename to: {buffer}");
                self.status_message = Some((msg, Instant::now()));
            }
            KeyCode::Char(c) => {
                buffer.push(c);
                let msg = format!("Rename to: {buffer}");
                self.status_message = Some((msg, Instant::now()));
            }
            _ => {}
        }
    }

    fn activate_selected_folder_with_focus(&mut self, focus_ai: bool) {
        let Some(folder) = self.folder_list.selected_folder().map(|p| p.to_path_buf()) else {
            return;
        };
        match self.tmux.activate_folder(&folder, !focus_ai) {
            Ok(()) => {}
            Err(err) => {
                self.set_status(err);
            }
        }
    }
}
