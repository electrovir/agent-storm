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
    WorktreeInput { buffer: String },
    RenameInput { folder: PathBuf, buffer: String },
}

/// Which settings field is currently being edited.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum SettingsField {
    AiCmd,
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
    ConfirmDeleteWorktree {
        folder: PathBuf,
    },
}

const STATUS_MESSAGE_TIMEOUT_SECS: u64 = 5;

pub struct App {
    folder_list: FolderList,
    tmux: TmuxController,
    should_quit: bool,
    ai_cmd: String,
    post_worktree_cmd: Option<String>,
    is_worktree_root: bool,
    folder_mode: FolderMode,
    status_message: Option<(String, Instant)>,
    modal: Modal,
    bg_sender: tokio_mpsc::UnboundedSender<BgMessage>,
    bg_receiver: tokio_mpsc::UnboundedReceiver<BgMessage>,
}

impl App {
    pub fn new(base_dir: PathBuf, ai_cmd: String, post_worktree_cmd: Option<String>) -> Self {
        let is_worktree_root = worktree::is_worktree_root(&base_dir);
        let session_name = tmux::session_name(&base_dir);
        let tmux = TmuxController::new(session_name, ai_cmd.clone());
        tmux.setup_session();

        let (bg_sender, bg_receiver) = tokio_mpsc::unbounded_channel();

        App {
            folder_list: FolderList::new(base_dir, is_worktree_root),
            tmux,
            should_quit: false,
            ai_cmd,
            post_worktree_cmd,
            is_worktree_root,
            folder_mode: FolderMode::Normal,
            status_message: None,
            modal: Modal::None,
            bg_sender,
            bg_receiver,
        }
    }

    pub fn folder_list(&self) -> &FolderList {
        &self.folder_list
    }

    pub fn tmux(&self) -> &TmuxController {
        &self.tmux
    }

    pub fn is_worktree_root(&self) -> bool {
        self.is_worktree_root
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
            post_worktree_cmd_buffer: self.post_worktree_cmd.clone().unwrap_or_default(),
            active_field: SettingsField::AiCmd,
        };
    }

    fn close_modal(&mut self) {
        let was_settings = matches!(self.modal, Modal::Settings { .. });
        self.modal = Modal::None;
        if was_settings {
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
                    self.post_worktree_cmd = if new_post_worktree_cmd.is_empty() {
                        None
                    } else {
                        Some(new_post_worktree_cmd.clone())
                    };

                    let cfg = config::Config {
                        ai_cmd: self.ai_cmd.clone(),
                        post_worktree_cmd: self.post_worktree_cmd.clone(),
                    };
                    match config::save_config(&cfg) {
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
        }
    }

    fn delete_worktree(&mut self, folder: &PathBuf) {
        // Kill the tmux session for this folder.
        self.tmux.remove_session(folder);

        self.folder_list.refresh();
        self.set_status("Deleting worktree...".to_string());

        let sibling = self
            .folder_list
            .folders()
            .iter()
            .find(|f| *f != folder)
            .cloned();

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
            FolderMode::WorktreeInput { .. } => self.handle_worktree_input_key(key),
            FolderMode::RenameInput { .. } => self.handle_rename_input_key(key),
        }
    }

    fn handle_folder_normal_key(&mut self, key: event::KeyEvent) {
        match key.code {
            KeyCode::Up | KeyCode::Char('k') => self.folder_list.move_up(),
            KeyCode::Down | KeyCode::Char('j') => self.folder_list.move_down(),
            KeyCode::Enter => self.activate_selected_folder_with_focus(true),
            KeyCode::Tab => self.activate_selected_folder_with_focus(false),
            KeyCode::Char('w') if self.is_worktree_root => {
                self.folder_mode = FolderMode::WorktreeInput {
                    buffer: String::new(),
                };
                self.set_status("New worktree branch name: ".to_string());
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
            KeyCode::Char('d') if self.is_worktree_root => {
                if let Some(folder) =
                    self.folder_list.selected_folder().map(|p| p.to_path_buf())
                {
                    self.modal = Modal::ConfirmDeleteWorktree { folder };
                }
            }
            _ => {}
        }
    }

    fn handle_worktree_input_key(&mut self, key: event::KeyEvent) {
        let FolderMode::WorktreeInput { buffer } = &mut self.folder_mode else {
            return;
        };

        match key.code {
            KeyCode::Esc => {
                self.folder_mode = FolderMode::Normal;
                self.status_message = None;
            }
            KeyCode::Enter => {
                let branch_name = buffer.clone();
                self.folder_mode = FolderMode::Normal;

                if branch_name.is_empty() {
                    self.set_status("Cancelled (empty name).".to_string());
                    return;
                }

                let Some(existing) = self.folder_list.selected_folder().map(|p| p.to_path_buf())
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
                            } else if let Some(cmd) = &self.post_worktree_cmd.clone() {
                                self.tmux.send_keys_to_shell(&folder, cmd);
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
                let msg = format!("New worktree branch name: {buffer}");
                self.status_message = Some((msg, Instant::now()));
            }
            KeyCode::Char(c) => {
                buffer.push(c);
                let msg = format!("New worktree branch name: {buffer}");
                self.status_message = Some((msg, Instant::now()));
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
