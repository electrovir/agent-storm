use bytes::Bytes;
use crossterm::event::{self, Event, KeyCode, KeyModifiers};
use portable_pty::CommandBuilder;
use std::io;
use std::path::PathBuf;
use std::time::Duration;

use crate::input::key_event_to_bytes;
use crate::pane::folder_list::FolderList;
use crate::pane::pty_pane::PtyPane;
use crate::ui;
use crate::worktree;

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
}

pub struct App {
    folder_list: FolderList,
    claude_pane: Option<PtyPane>,
    shell_pane: Option<PtyPane>,
    focus: Focus,
    should_quit: bool,
    last_pty_cols: u16,
    last_pty_rows: u16,
    ai_cmd: String,
    is_worktree_root: bool,
    folder_mode: FolderMode,
    status_message: Option<String>,
}

impl App {
    pub fn new(base_dir: PathBuf, ai_cmd: String) -> Self {
        let is_worktree_root = worktree::is_worktree_root(&base_dir);
        App {
            folder_list: FolderList::new(base_dir),
            claude_pane: None,
            shell_pane: None,
            focus: Focus::FolderList,
            should_quit: false,
            last_pty_cols: 80,
            last_pty_rows: 24,
            ai_cmd,
            is_worktree_root,
            folder_mode: FolderMode::Normal,
            status_message: None,
        }
    }

    pub fn folder_list(&self) -> &FolderList {
        &self.folder_list
    }

    pub fn claude_pane(&self) -> Option<&PtyPane> {
        self.claude_pane.as_ref()
    }

    pub fn shell_pane(&self) -> Option<&PtyPane> {
        self.shell_pane.as_ref()
    }

    pub fn focus(&self) -> Focus {
        self.focus
    }

    pub fn is_worktree_root(&self) -> bool {
        self.is_worktree_root
    }

    pub fn folder_mode(&self) -> &FolderMode {
        &self.folder_mode
    }

    pub fn status_message(&self) -> Option<&str> {
        self.status_message.as_deref()
    }

    pub fn ai_cmd(&self) -> &str {
        &self.ai_cmd
    }

    pub async fn run(&mut self, terminal: &mut ratatui::DefaultTerminal) -> io::Result<()> {
        loop {
            // Compute PTY sizes from the current layout.
            self.update_pty_sizes(terminal.size()?.into());

            terminal.draw(|frame| ui::render(frame, self))?;

            if event::poll(Duration::from_millis(16))? {
                match event::read()? {
                    Event::Key(key) => self.handle_key_event(key),
                    Event::Resize(_, _) => {}
                    _ => {}
                }
            }

            if self.should_quit {
                return Ok(());
            }
        }
    }

    fn handle_key_event(&mut self, key: event::KeyEvent) {
        let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);

        // Global bindings (always work except during text input).
        if self.folder_mode == FolderMode::Normal {
            match key.code {
                KeyCode::Char('q') if ctrl => {
                    self.should_quit = true;
                    return;
                }
                KeyCode::Char('1') if ctrl => {
                    self.focus = Focus::FolderList;
                    return;
                }
                KeyCode::Char('2') if ctrl => {
                    self.focus = Focus::ClaudePane;
                    return;
                }
                KeyCode::Char('3') if ctrl => {
                    self.focus = Focus::ShellPane;
                    return;
                }
                _ => {}
            }
        }

        match self.focus {
            Focus::FolderList => self.handle_folder_key(key),
            Focus::ClaudePane => self.forward_to_pane(key, PaneTarget::Claude),
            Focus::ShellPane => self.forward_to_pane(key, PaneTarget::Shell),
        }
    }

    fn handle_folder_key(&mut self, key: event::KeyEvent) {
        match &self.folder_mode {
            FolderMode::Normal => self.handle_folder_normal_key(key),
            FolderMode::WorktreeInput { .. } => self.handle_worktree_input_key(key),
        }
    }

    fn handle_folder_normal_key(&mut self, key: event::KeyEvent) {
        match key.code {
            KeyCode::Up | KeyCode::Char('k') => self.folder_list.move_up(),
            KeyCode::Down | KeyCode::Char('j') => self.folder_list.move_down(),
            KeyCode::Enter => self.spawn_panes_for_selected(),
            KeyCode::Char('r') => self.folder_list.refresh(),
            KeyCode::Char('w') if self.is_worktree_root => {
                self.folder_mode = FolderMode::WorktreeInput {
                    buffer: String::new(),
                };
                self.status_message = Some("New worktree branch name: ".to_string());
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
                    self.status_message = Some("Cancelled (empty name).".to_string());
                    return;
                }

                // Use any existing worktree folder to run the command from.
                let Some(existing) = self.folder_list.selected_folder().map(|p| p.to_path_buf())
                else {
                    self.status_message = Some("No folder selected.".to_string());
                    return;
                };

                match worktree::add_worktree(&existing, &branch_name) {
                    Ok(msg) => {
                        self.status_message = Some(msg);
                        self.folder_list.refresh();
                    }
                    Err(msg) => {
                        self.status_message = Some(msg);
                    }
                }
            }
            KeyCode::Backspace => {
                buffer.pop();
                self.status_message = Some(format!("New worktree branch name: {buffer}"));
            }
            KeyCode::Char(c) => {
                buffer.push(c);
                self.status_message = Some(format!("New worktree branch name: {buffer}"));
            }
            _ => {}
        }
    }

    fn forward_to_pane(&self, key: event::KeyEvent, target: PaneTarget) {
        let pane = match target {
            PaneTarget::Claude => &self.claude_pane,
            PaneTarget::Shell => &self.shell_pane,
        };
        if let Some(pane) = pane {
            if let Some(bytes) = key_event_to_bytes(&key) {
                pane.send_input(Bytes::from(bytes));
            }
        }
    }

    fn spawn_panes_for_selected(&mut self) {
        let Some(folder) = self.folder_list.selected_folder().map(|p| p.to_path_buf()) else {
            return;
        };

        // Drop existing panes (kills their child processes).
        self.claude_pane = None;
        self.shell_pane = None;

        let rows = self.last_pty_rows;
        let cols = self.last_pty_cols;

        // Spawn the AI command (configurable, defaults to "claude").
        let ai_parts: Vec<&str> = self.ai_cmd.split_whitespace().collect();
        if let Some((&program, args)) = ai_parts.split_first() {
            let mut ai_command = CommandBuilder::new(program);
            for arg in args {
                ai_command.arg(arg);
            }
            ai_command.cwd(&folder);
            match PtyPane::spawn(ai_command, rows, cols) {
                Ok(pane) => self.claude_pane = Some(pane),
                Err(err) => {
                    self.status_message = Some(format!("Failed to spawn AI: {err}"));
                }
            }
        }

        // Spawn user's default shell.
        let mut shell_cmd = CommandBuilder::new_default_prog();
        shell_cmd.cwd(&folder);
        match PtyPane::spawn(shell_cmd, rows, cols) {
            Ok(pane) => self.shell_pane = Some(pane),
            Err(err) => {
                self.status_message = Some(format!("Failed to spawn shell: {err}"));
            }
        }

        self.focus = Focus::ClaudePane;
    }

    fn update_pty_sizes(&mut self, terminal_size: ratatui::layout::Rect) {
        // Approximate the PTY pane inner dimensions:
        // Each PTY column is ~40% of the terminal width, minus 2 for borders.
        let pane_width = ((terminal_size.width as u32 * 40) / 100).saturating_sub(2) as u16;
        let pane_height = terminal_size.height.saturating_sub(2);

        if pane_width != self.last_pty_cols || pane_height != self.last_pty_rows {
            self.last_pty_cols = pane_width;
            self.last_pty_rows = pane_height;

            if let Some(ref pane) = self.claude_pane {
                pane.resize(pane_height, pane_width);
            }
            if let Some(ref pane) = self.shell_pane {
                pane.resize(pane_height, pane_width);
            }
        }
    }
}

enum PaneTarget {
    Claude,
    Shell,
}
