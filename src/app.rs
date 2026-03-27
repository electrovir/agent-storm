use bytes::Bytes;
use crossterm::event::{self, Event, KeyCode, KeyModifiers, MouseButton, MouseEventKind};
use portable_pty::CommandBuilder;
use std::collections::HashMap;
use std::io;
use std::path::PathBuf;
use std::time::{Duration, Instant};
use tokio::sync::mpsc as tokio_mpsc;

const STATUS_MESSAGE_TIMEOUT_SECS: u64 = 5;

use crate::config;
use crate::input::key_event_to_bytes;
use crate::pane::folder_list::FolderList;
use crate::pane::pty_pane::PtyPane;
use crate::ui::{self, ColumnRects};
use crate::worktree;

enum BgMessage {
    StatusMessage(String),
    RefreshFolders,
    DirtyResults(std::collections::HashMap<PathBuf, bool>),
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Focus {
    FolderList,
    ClaudePane,
    ShellPane,
}

/// What the folder list input mode is doing.
#[derive(Clone, PartialEq, Eq)]
pub enum FolderMode {
    /// Normal navigation.
    Normal,
    /// Typing a branch name for `git worktree add`.
    WorktreeInput { buffer: String },
    /// Typing a new name for renaming the selected folder.
    RenameInput { folder: PathBuf, buffer: String },
}

/// Which settings field is currently being edited.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum SettingsField {
    AiCmd,
    PostWorktreeCmd,
    Mouse,
}

/// Modal dialog state.
#[derive(Clone, PartialEq, Eq)]
pub enum Modal {
    None,
    Settings {
        ai_cmd_buffer: String,
        post_worktree_cmd_buffer: String,
        mouse: bool,
        active_field: SettingsField,
    },
    ConfirmDeleteWorktree {
        folder: PathBuf,
    },
}

pub struct Session {
    pub ai_pane: PtyPane,
    pub shell_pane: PtyPane,
}

pub struct App {
    folder_list: FolderList,
    sessions: HashMap<PathBuf, Session>,
    active_folder: Option<PathBuf>,
    focus: Focus,
    should_quit: bool,
    last_pty_cols: u16,
    last_pty_rows: u16,
    ai_cmd: String,
    post_worktree_cmd: Option<String>,
    is_worktree_root: bool,
    folder_mode: FolderMode,
    status_message: Option<(String, Instant)>,
    column_rects: Option<ColumnRects>,
    modal: Modal,
    mouse_capture: bool,
    fullscreen: bool,
    needs_clear: bool,
    mouse_capture_before_fullscreen: bool,
    bg_sender: tokio_mpsc::UnboundedSender<BgMessage>,
    bg_receiver: tokio_mpsc::UnboundedReceiver<BgMessage>,
}

impl App {
    pub fn new(
        base_dir: PathBuf,
        ai_cmd: String,
        post_worktree_cmd: Option<String>,
        mouse_capture: bool,
    ) -> Self {
        let is_worktree_root = worktree::is_worktree_root(&base_dir);
        let (bg_sender, bg_receiver) = tokio_mpsc::unbounded_channel();
        App {
            folder_list: FolderList::new(base_dir, is_worktree_root),
            sessions: HashMap::new(),
            active_folder: None,
            focus: Focus::FolderList,
            should_quit: false,
            last_pty_cols: 80,
            last_pty_rows: 24,
            ai_cmd,
            post_worktree_cmd,
            is_worktree_root,
            folder_mode: FolderMode::Normal,
            status_message: None,
            column_rects: None,
            modal: Modal::None,
            mouse_capture,
            fullscreen: false,
            needs_clear: false,
            mouse_capture_before_fullscreen: mouse_capture,
            bg_sender,
            bg_receiver,
        }
    }

    pub fn folder_list(&self) -> &FolderList {
        &self.folder_list
    }

    pub fn active_session(&self) -> Option<&Session> {
        self.active_folder
            .as_ref()
            .and_then(|f| self.sessions.get(f))
    }

    pub fn session_for(&self, folder: &PathBuf) -> Option<&Session> {
        self.sessions.get(folder)
    }

    pub fn active_folder(&self) -> Option<&PathBuf> {
        self.active_folder.as_ref()
    }

    pub fn active_folder_name(&self) -> Option<&str> {
        self.active_folder
            .as_ref()
            .and_then(|f| f.file_name())
            .and_then(|n| n.to_str())
    }

    pub fn focus(&self) -> Focus {
        self.focus
    }

    pub fn is_worktree_root(&self) -> bool {
        self.is_worktree_root
    }

    pub fn mouse_capture(&self) -> bool {
        self.mouse_capture
    }

    pub fn is_fullscreen(&self) -> bool {
        self.fullscreen
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

    pub async fn run(&mut self, terminal: &mut ratatui::DefaultTerminal) -> io::Result<()> {
        loop {
            // Spawn background dirty check if needed.
            if let Some((folders, in_flight)) = self.folder_list.maybe_start_dirty_check() {
                let sender = self.bg_sender.clone();
                tokio::task::spawn_blocking(move || {
                    let results = crate::pane::folder_list::check_dirty_all(&folders);
                    in_flight.store(false, std::sync::atomic::Ordering::SeqCst);
                    let _ = sender.send(BgMessage::DirtyResults(results));
                });
            }

            if self.needs_clear {
                terminal.clear()?;
                self.needs_clear = false;
            }

            let mut rects = None;
            terminal.draw(|frame| {
                rects = Some(ui::render(frame, self));
            })?;

            // Update PTY sizes from the actual rendered pane areas.
            if let Some(ref r) = rects {
                self.update_pty_sizes_from_rects(r);
            }
            self.column_rects = rects;

            // Drain background task messages.
            while let Ok(msg) = self.bg_receiver.try_recv() {
                match msg {
                    BgMessage::StatusMessage(text) => self.set_status(text),
                    BgMessage::RefreshFolders => self.folder_list.refresh(),
                    BgMessage::DirtyResults(results) => self.folder_list.apply_dirty(results),
                }
            }

            // Use poll with a short timeout, then yield to tokio so async tasks
            // (like the PTY writer) get a chance to run.
            if event::poll(Duration::from_millis(1))? {
                match event::read()? {
                    Event::Key(key) => self.handle_key_event(key),
                    Event::Mouse(mouse) => self.handle_mouse_event(mouse),
                    Event::Resize(_, _) => {
                        // Force a full redraw to recover from Cmd+K or other screen clears.
                        terminal.clear()?;
                    }
                    _ => {}
                }
            }
            // Yield to the tokio executor so async tasks (PTY writer) can run.
            tokio::task::yield_now().await;

            if self.should_quit {
                // Drop all sessions so child processes and blocking reader
                // threads are cleaned up before the tokio runtime shuts down.
                self.sessions.clear();
                return Ok(());
            }
        }
    }

    fn handle_mouse_event(&mut self, mouse: event::MouseEvent) {
        // Ignore mouse events when a modal is open.
        if self.modal != Modal::None {
            return;
        }

        if !matches!(mouse.kind, MouseEventKind::Down(MouseButton::Left)) {
            return;
        }

        let Some(ref rects) = self.column_rects else {
            return;
        };

        let x = mouse.column;
        let y = mouse.row;

        if rect_contains(rects.folder_list, x, y) {
            self.focus = Focus::FolderList;
        } else if rect_contains(rects.claude_pane, x, y) {
            self.focus = Focus::ClaudePane;
        } else if rect_contains(rects.shell_pane, x, y) {
            self.focus = Focus::ShellPane;
        }
    }

    fn handle_key_event(&mut self, key: event::KeyEvent) {
        // Modal gets all input when open.
        if self.modal != Modal::None {
            self.handle_modal_key(key);
            return;
        }

        let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
        let alt = key.modifiers.contains(KeyModifiers::ALT);

        // Global bindings (always work except during text input).
        if self.folder_mode == FolderMode::Normal {
            match key.code {
                KeyCode::Char('q') if ctrl => {
                    self.should_quit = true;
                    return;
                }
                KeyCode::Char('1') if alt => {
                    self.focus = Focus::FolderList;
                    return;
                }
                KeyCode::Char('2') if alt => {
                    self.focus = Focus::ClaudePane;
                    return;
                }
                KeyCode::Char('3') if alt => {
                    self.focus = Focus::ShellPane;
                    return;
                }
                KeyCode::Char('s') if alt => {
                    self.open_settings();
                    return;
                }
                KeyCode::Char('m') if alt => {
                    self.toggle_mouse_capture();
                    return;
                }
                KeyCode::Char('f') if alt => {
                    self.toggle_fullscreen();
                    return;
                }
                KeyCode::Char('r') if alt => {
                    self.needs_clear = true;
                    return;
                }
                _ => {}
            }
        }

        match self.focus {
            Focus::FolderList => self.handle_folder_key(key),
            Focus::ClaudePane => self.forward_to_pane(key, PaneTarget::Ai),
            Focus::ShellPane => self.forward_to_pane(key, PaneTarget::Shell),
        }
    }

    fn toggle_mouse_capture(&mut self) {
        self.mouse_capture = !self.mouse_capture;
        if self.mouse_capture {
            let _ = crossterm::execute!(
                io::stdout(),
                crossterm::event::EnableMouseCapture
            );
            self.set_status("Mouse capture ON (click to focus panes).".to_string());
        } else {
            let _ = crossterm::execute!(
                io::stdout(),
                crossterm::event::DisableMouseCapture
            );
            self.set_status("Mouse capture OFF (text selection enabled).".to_string());
        }
    }

    fn toggle_fullscreen(&mut self) {
        if self.fullscreen {
            // Exit fullscreen.
            self.fullscreen = false;
            // Restore mouse capture to what it was before fullscreen.
            if self.mouse_capture_before_fullscreen && !self.mouse_capture {
                self.mouse_capture = true;
                let _ = crossterm::execute!(
                    io::stdout(),
                    crossterm::event::EnableMouseCapture
                );
            }
        } else {
            // Enter fullscreen — only for AI or shell panes.
            if self.focus == Focus::FolderList {
                return;
            }
            self.fullscreen = true;
            // Save current mouse capture state and disable it.
            self.mouse_capture_before_fullscreen = self.mouse_capture;
            if self.mouse_capture {
                self.mouse_capture = false;
                let _ = crossterm::execute!(
                    io::stdout(),
                    crossterm::event::DisableMouseCapture
                );
            }
        }
    }

    fn open_settings(&mut self) {
        self.modal = Modal::Settings {
            ai_cmd_buffer: self.ai_cmd.clone(),
            post_worktree_cmd_buffer: self.post_worktree_cmd.clone().unwrap_or_default(),
            mouse: self.mouse_capture,
            active_field: SettingsField::AiCmd,
        };
    }

    fn handle_modal_key(&mut self, key: event::KeyEvent) {
        match &mut self.modal {
            Modal::None => {}
            Modal::Settings {
                ai_cmd_buffer,
                post_worktree_cmd_buffer,
                mouse,
                active_field,
            } => match key.code {
                KeyCode::Esc => {
                    self.modal = Modal::None;
                }
                KeyCode::Tab | KeyCode::Up | KeyCode::Down => {
                    *active_field = match active_field {
                        SettingsField::AiCmd => SettingsField::PostWorktreeCmd,
                        SettingsField::PostWorktreeCmd => SettingsField::Mouse,
                        SettingsField::Mouse => SettingsField::AiCmd,
                    };
                }
                KeyCode::Char(' ') if *active_field == SettingsField::Mouse => {
                    *mouse = !*mouse;
                }
                KeyCode::Enter => {
                    let new_ai_cmd = ai_cmd_buffer.trim().to_string();
                    let new_post_worktree_cmd = post_worktree_cmd_buffer.trim().to_string();
                    let save_mouse = *mouse;

                    if !new_ai_cmd.is_empty() {
                        self.ai_cmd = new_ai_cmd.clone();
                    }
                    self.post_worktree_cmd = if new_post_worktree_cmd.is_empty() {
                        None
                    } else {
                        Some(new_post_worktree_cmd.clone())
                    };

                    let cfg = config::Config {
                        ai_cmd: self.ai_cmd.clone(),
                        post_worktree_cmd: self.post_worktree_cmd.clone(),
                        mouse: save_mouse,
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
                    self.modal = Modal::None;
                }
                KeyCode::Backspace => match active_field {
                    SettingsField::AiCmd => {
                        ai_cmd_buffer.pop();
                    }
                    SettingsField::PostWorktreeCmd => {
                        post_worktree_cmd_buffer.pop();
                    }
                    SettingsField::Mouse => {}
                },
                KeyCode::Char(c) => match active_field {
                    SettingsField::AiCmd => {
                        ai_cmd_buffer.push(c);
                    }
                    SettingsField::PostWorktreeCmd => {
                        post_worktree_cmd_buffer.push(c);
                    }
                    SettingsField::Mouse => {}
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
        // Drop the session immediately (kills child processes in background).
        let session = self.sessions.remove(folder);
        if self.active_folder.as_ref() == Some(folder) {
            self.active_folder = None;
        }

        // Hide the folder from the list right away.
        self.folder_list.refresh();
        self.set_status("Deleting worktree...".to_string());

        // Find a sibling worktree to run git from.
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
            // Drop the session on this thread so PTY cleanup doesn't block the UI.
            drop(session);

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
            KeyCode::Enter => self.activate_selected_folder(),
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
            KeyCode::Char('d') if self.is_worktree_root => {
                if let Some(folder) = self.folder_list.selected_folder().map(|p| p.to_path_buf()) {
                    self.modal = Modal::ConfirmDeleteWorktree {
                        folder,
                    };
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

                // Use any existing worktree folder to run the command from.
                let Some(existing) = self.folder_list.selected_folder().map(|p| p.to_path_buf())
                else {
                    self.set_status("No folder selected.".to_string());
                    return;
                };

                match worktree::add_worktree(&existing, &branch_name) {
                    Ok(msg) => {
                        self.set_status(msg);
                        self.folder_list.refresh();

                        // Find the new worktree folder and activate it.
                        let new_folder = existing.parent().map(|p| p.join(&branch_name));
                        if let Some(folder) = new_folder
                            && folder.is_dir()
                        {
                            self.activate_folder(folder);

                            // Send the post-worktree command to the shell pane.
                            if let Some(cmd) = &self.post_worktree_cmd.clone()
                                && let Some(session) = self.active_folder.as_ref().and_then(|f| self.sessions.get(f))
                            {
                                let input = format!("{cmd}\n");
                                session.shell_pane.send_input(Bytes::from(input));
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

                // Check if the name actually changed.
                let old_name = folder
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("");
                if new_name == old_name {
                    self.set_status("Name unchanged.".to_string());
                    return;
                }

                match worktree::rename_folder(&folder, &new_name) {
                    Ok((msg, new_path)) => {
                        // Update session key if this folder had a session.
                        if let Some(session) = self.sessions.remove(&folder) {
                            self.sessions.insert(new_path.clone(), session);
                        }
                        if self.active_folder.as_ref() == Some(&folder) {
                            self.active_folder = Some(new_path);
                        }
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

    fn forward_to_pane(&self, key: event::KeyEvent, target: PaneTarget) {
        let session = self.active_session();
        let pane = session.map(|s| match target {
            PaneTarget::Ai => &s.ai_pane,
            PaneTarget::Shell => &s.shell_pane,
        });
        if let Some(pane) = pane {
            let app_cursor = pane.screen().application_cursor();
            if let Some(bytes) = key_event_to_bytes(&key, app_cursor) {
                pane.send_input(Bytes::from(bytes));
            }
        }
    }

    fn activate_selected_folder(&mut self) {
        let Some(folder) = self.folder_list.selected_folder().map(|p| p.to_path_buf()) else {
            return;
        };
        self.activate_folder(folder);
    }

    fn activate_folder(&mut self, folder: PathBuf) {
        // If this folder already has a session, just switch to it.
        if self.sessions.contains_key(&folder) {
            self.active_folder = Some(folder);
            self.focus = Focus::ClaudePane;
            return;
        }

        // Spawn new session for this folder.
        let rows = self.last_pty_rows;
        let cols = self.last_pty_cols;

        let ai_pane = self.spawn_ai_pane(&folder, rows, cols);
        let shell_pane = self.spawn_shell_pane(&folder, rows, cols);

        match (ai_pane, shell_pane) {
            (Ok(ai), Ok(shell)) => {
                self.sessions.insert(
                    folder.clone(),
                    Session {
                        ai_pane: ai,
                        shell_pane: shell,
                    },
                );
                self.active_folder = Some(folder);
                self.focus = Focus::ClaudePane;
            }
            (Err(err), _) => {
                self.set_status(format!("Failed to spawn AI: {err}"));
            }
            (_, Err(err)) => {
                self.set_status(format!("Failed to spawn shell: {err}"));
            }
        }
    }

    fn spawn_ai_pane(&self, folder: &PathBuf, rows: u16, cols: u16) -> io::Result<PtyPane> {
        let ai_parts: Vec<&str> = self.ai_cmd.split_whitespace().collect();
        let Some((&program, args)) = ai_parts.split_first() else {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "Empty AI command"));
        };
        let mut cmd = CommandBuilder::new(program);
        for arg in args {
            cmd.arg(arg);
        }
        cmd.cwd(folder);
        cmd.env("TERM", "xterm-256color");
        PtyPane::spawn(cmd, rows, cols)
    }

    fn spawn_shell_pane(&self, folder: &PathBuf, rows: u16, cols: u16) -> io::Result<PtyPane> {
        let mut cmd = CommandBuilder::new_default_prog();
        cmd.cwd(folder);
        cmd.env("TERM", "xterm-256color");
        PtyPane::spawn(cmd, rows, cols)
    }

    /// Update PTY sizes based on actual rendered pane areas.
    pub fn update_pty_sizes_from_rects(&mut self, rects: &ColumnRects) {
        // Inner area = rect minus borders (1 on each side), unless fullscreen (no borders).
        let border = if self.fullscreen { 0 } else { 2 };
        let ai_width = rects.claude_pane.width.saturating_sub(border);
        let ai_height = rects.claude_pane.height.saturating_sub(border);
        let shell_width = rects.shell_pane.width.saturating_sub(border);
        let shell_height = rects.shell_pane.height.saturating_sub(border);

        // Use AI pane dimensions for spawning (they're usually the same as shell).
        let spawn_width = if ai_width > 0 { ai_width } else { shell_width };
        let spawn_height = if ai_height > 0 { ai_height } else { shell_height };
        if spawn_width > 0 {
            self.last_pty_cols = spawn_width;
        }
        if spawn_height > 0 {
            self.last_pty_rows = spawn_height;
        }

        for session in self.sessions.values() {
            if ai_width > 0 && ai_height > 0 {
                session.ai_pane.resize(ai_height, ai_width);
            }
            if shell_width > 0 && shell_height > 0 {
                session.shell_pane.resize(shell_height, shell_width);
            }
        }
    }
}

enum PaneTarget {
    Ai,
    Shell,
}

fn rect_contains(rect: ratatui::layout::Rect, x: u16, y: u16) -> bool {
    x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height
}
