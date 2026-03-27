use crate::app::{AddRepoField, App, FolderMode, Modal, SettingsField};
use ratatui::layout::{Constraint, Direction, Layout};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{
    Block, BorderType, Borders, Clear, Paragraph, Wrap,
};
use ratatui::Frame;
use std::time::{SystemTime, UNIX_EPOCH};

const FOCUS_COLOR: Color = Color::LightCyan;
const SPINNER_FRAMES: &[char] = &['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

const AI_BUSY_THRESHOLD_SECS: u64 = 2;
const SHELL_BUSY_THRESHOLD_SECS: u64 = 5;

fn spinner_char() -> char {
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let idx = (ms / 100) as usize % SPINNER_FRAMES.len();
    SPINNER_FRAMES[idx]
}

pub fn render(frame: &mut Frame, app: &App) {
    let area = frame.area();

    let vertical = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Min(3), Constraint::Length(1)])
        .split(area);

    let main_area = vertical[0];
    let status_area = vertical[1];

    render_folder_list(frame, app, main_area);
    render_status_bar(frame, app, status_area);

    // Render modal on top of everything.
    match app.modal() {
        Modal::Settings {
            ai_cmd_buffer,
            post_worktree_cmd_buffer,
            active_field,
        } => {
            render_settings_modal(
                frame,
                ai_cmd_buffer,
                post_worktree_cmd_buffer,
                *active_field,
            );
        }
        Modal::AddWorktree { buffer } => {
            render_add_worktree_modal(frame, buffer);
        }
        Modal::AddRepo {
            path_buffer,
            pwc_buffer,
            active_field,
        } => {
            render_add_repo_modal(frame, path_buffer, pwc_buffer, *active_field);
        }
        Modal::ConfirmDeleteWorktree { folder } => {
            render_confirm_delete_modal(frame, folder);
        }
        Modal::ConfirmAddNewRepo { repo_path } => {
            render_confirm_add_repo_modal(frame, repo_path);
        }
        Modal::NewRepoPostWorktreeCmd { buffer, .. } => {
            render_new_repo_pwc_modal(frame, buffer);
        }
        Modal::Help => {
            render_help_modal(frame, app.selected_is_worktree(), app.is_lone());
        }
        Modal::None => {}
    }
}

/// Returns styled spans showing per-pane status for a folder.
fn pane_char_color(
    tmux: &crate::tmux::TmuxController,
    pane_id: &str,
    threshold_secs: u64,
) -> (char, Color) {
    if !tmux.is_pane_alive(pane_id) {
        ('x', Color::Red)
    } else if tmux.is_pane_busy(pane_id, threshold_secs) {
        (spinner_char(), Color::Green)
    } else {
        ('-', Color::DarkGray)
    }
}

fn render_folder_list(frame: &mut Frame, app: &App, area: ratatui::layout::Rect) {
    use crate::pane::folder_list::{GitStatus, SidebarEntry};

    let focused = app.tmux().is_sidebar_focused();

    let border_color = if focused {
        FOCUS_COLOR
    } else {
        Color::DarkGray
    };
    let border_type = if focused {
        BorderType::Thick
    } else {
        BorderType::Plain
    };

    let block = Block::default()
        .title(Line::from(" Repos "))
        .borders(Borders::ALL)
        .border_type(border_type)
        .border_style(Style::default().fg(border_color));

    let inner = block.inner(area);
    frame.render_widget(block, area);

    let selected_entry_idx = app.folder_list().selected_entry_index();
    let active_folder = app.active_folder();
    let active_entry_idx = app
        .folder_list()
        .entries()
        .iter()
        .position(|e| e.is_selectable() && Some(e.path()) == active_folder.map(|p| p.as_path()));

    let lines: Vec<Line> = app
        .folder_list()
        .entries()
        .iter()
        .enumerate()
        .map(|(idx, entry)| {
            match entry {
                SidebarEntry::RepoHeader { name, .. } => {
                    Line::from(Span::styled(
                        name.clone(),
                        Style::default()
                            .fg(Color::DarkGray)
                            .add_modifier(Modifier::BOLD),
                    ))
                }
                SidebarEntry::Item { path, name, indented, .. } => {
                    let indent = if *indented { "  " } else { "" };
                    let mut spans: Vec<Span> = Vec::new();
                    spans.push(Span::raw(indent.to_string()));

                    // Pane status indicators.
                    if let Some(session) = app.tmux().session_for(path) {
                        let tmux = app.tmux();
                        let (ai_ch, ai_color) = pane_char_color(tmux, &session.ai_pane_id, AI_BUSY_THRESHOLD_SECS);
                        let (sh_ch, sh_color) = pane_char_color(tmux, &session.shell_pane_id, SHELL_BUSY_THRESHOLD_SECS);
                        spans.push(Span::styled(format!("{ai_ch}"), Style::default().fg(ai_color)));
                        spans.push(Span::styled(format!("{sh_ch}"), Style::default().fg(sh_color)));
                        spans.push(Span::raw(" "));
                    } else {
                        spans.push(Span::raw("   "));
                    }

                    spans.push(Span::raw(name.clone()));

                    match app.folder_list().git_status(path) {
                        GitStatus::Dirty => spans.push(Span::raw("*")),
                        GitStatus::Unpushed => spans.push(Span::raw("+")),
                        GitStatus::Clean => {}
                    }

                    let is_selected = selected_entry_idx == Some(idx);
                    let is_active = active_entry_idx == Some(idx);

                    let style = if focused && is_selected {
                        Style::new().add_modifier(Modifier::REVERSED | Modifier::BOLD)
                    } else if is_active {
                        Style::new()
                            .fg(Color::DarkGray)
                            .add_modifier(Modifier::REVERSED)
                    } else {
                        Style::new()
                    };

                    Line::from(spans).style(style)
                }
            }
        })
        .collect();

    let paragraph = Paragraph::new(lines);
    frame.render_widget(paragraph, inner);
}

fn render_status_bar(frame: &mut Frame, app: &App, area: ratatui::layout::Rect) {
    let buf = frame.buffer_mut();
    let style = Style::default().fg(Color::White).bg(Color::DarkGray);
    for x in area.x..area.x + area.width {
        for y in area.y..area.y + area.height {
            let cell = &mut buf[(x, y)];
            cell.reset();
            cell.set_style(style);
        }
    }

    let status_text = match app.folder_mode() {
        FolderMode::RenameInput { buffer, .. } => {
            format!("Rename to: {buffer}_")
        }
        FolderMode::Normal => {
            if let Some(msg) = app.status_message() {
                msg.to_string()
            } else if app.tmux().is_sidebar_focused() {
                " ?:help  ^Q:quit".to_string()
            } else {
                " ^Q:quit".to_string()
            }
        }
    };

    let bar = Paragraph::new(Span::styled(status_text, style));
    frame.render_widget(bar, area);
}

fn render_settings_modal(
    frame: &mut Frame,
    ai_cmd_buffer: &str,
    post_worktree_cmd_buffer: &str,
    active_field: SettingsField,
) {
    let area = frame.area().centered(
        Constraint::Length(56.min(frame.area().width.saturating_sub(4))),
        Constraint::Length(9),
    );

    frame.render_widget(Clear, area);

    let block = Block::default()
        .title(" Settings ")
        .borders(Borders::ALL)
        .border_type(BorderType::Thick)
        .border_style(Style::default().fg(FOCUS_COLOR));

    let inner = block.inner(area);
    frame.render_widget(block, area);

    let active_style = Style::default()
        .fg(FOCUS_COLOR)
        .add_modifier(Modifier::BOLD);
    let inactive_style = Style::default().fg(Color::DarkGray);

    let ai_cursor = if active_field == SettingsField::AiCmd {
        "_"
    } else {
        ""
    };
    let pwc_cursor = if active_field == SettingsField::PostWorktreeCmd {
        "_"
    } else {
        ""
    };

    let field_style = |field: SettingsField| -> Style {
        if active_field == field {
            active_style
        } else {
            inactive_style
        }
    };

    let lines = vec![
        Line::from(vec![
            Span::styled("AI command:         ", Style::default().fg(Color::DarkGray)),
            Span::styled(
                format!("{ai_cmd_buffer}{ai_cursor}"),
                field_style(SettingsField::AiCmd),
            ),
        ]),
        Line::from(vec![
            Span::styled("Post-worktree cmd:  ", Style::default().fg(Color::DarkGray)),
            Span::styled(
                format!("{post_worktree_cmd_buffer}{pwc_cursor}"),
                field_style(SettingsField::PostWorktreeCmd),
            ),
        ]),
        Line::raw(""),
        Line::from(vec![
            Span::styled("Tab", Style::default().fg(FOCUS_COLOR)),
            Span::raw(" switch field  "),
            Span::styled("Enter", Style::default().fg(FOCUS_COLOR)),
            Span::raw(" save  "),
            Span::styled("Esc", Style::default().fg(FOCUS_COLOR)),
            Span::raw(" cancel"),
        ]),
    ];

    let content = Paragraph::new(lines).wrap(Wrap { trim: false });
    frame.render_widget(content, inner);
}

fn render_confirm_delete_modal(frame: &mut Frame, folder: &std::path::Path) {
    let name = folder
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("?");

    let area = frame.area().centered(
        Constraint::Length(50.min(frame.area().width.saturating_sub(4))),
        Constraint::Length(6),
    );

    frame.render_widget(Clear, area);

    let block = Block::default()
        .title(" Delete Worktree ")
        .borders(Borders::ALL)
        .border_type(BorderType::Thick)
        .border_style(Style::default().fg(Color::Red));

    let inner = block.inner(area);
    frame.render_widget(block, area);

    let lines = vec![
        Line::from(vec![
            Span::raw("Delete worktree "),
            Span::styled(
                name,
                Style::default()
                    .fg(Color::Red)
                    .add_modifier(Modifier::BOLD),
            ),
            Span::raw("?"),
        ]),
        Line::raw(""),
        Line::from(vec![
            Span::styled(
                "y",
                Style::default()
                    .fg(Color::Red)
                    .add_modifier(Modifier::BOLD),
            ),
            Span::raw(" confirm  "),
            Span::styled("n", Style::default().fg(FOCUS_COLOR)),
            Span::raw("/"),
            Span::styled("Esc", Style::default().fg(FOCUS_COLOR)),
            Span::raw(" cancel"),
        ]),
    ];

    let content = Paragraph::new(lines).wrap(Wrap { trim: false });
    frame.render_widget(content, inner);
}

fn render_help_modal(frame: &mut Frame, is_worktree: bool, is_lone: bool) {
    let mut lines = vec![
        help_line("Enter", "Open + focus AI"),
        help_line("Tab", "Open + stay"),
        help_line("j/k", "Navigate"),
        help_line("r", "Rename"),
        help_line("x", "Restart dead panes"),
    ];

    if !is_lone {
        lines.push(help_line("a", "Add repo"));
        lines.push(help_line("o", "Open config"));
    }

    lines.extend([
        help_line("^Q", "Quit"),
        help_line("M-S", "Settings"),
        Line::raw(""),
        help_line("M-1/2/3", "Focus pane"),
        help_line("M-F", "Zoom pane"),
    ]);

    if is_worktree {
        lines.push(Line::raw(""));
        lines.push(help_line("w", "Add worktree"));
        lines.push(help_line("d", "Del worktree"));
    }

    lines.push(Line::raw(""));
    lines.push(Line::from(Span::styled(
        " any key to close",
        Style::default().fg(Color::DarkGray),
    )));

    let height = (lines.len() + 2) as u16;
    let width = frame.area().width.saturating_sub(2);
    let area = frame.area().centered(
        Constraint::Length(width),
        Constraint::Length(height),
    );

    frame.render_widget(Clear, area);

    let block = Block::default()
        .title(" Help ")
        .borders(Borders::ALL)
        .border_type(BorderType::Thick)
        .border_style(Style::default().fg(FOCUS_COLOR));

    let inner = block.inner(area);
    frame.render_widget(block, area);

    let content = Paragraph::new(lines);
    frame.render_widget(content, inner);
}

fn help_line<'a>(key: &'a str, desc: &'a str) -> Line<'a> {
    Line::from(vec![
        Span::styled(
            format!("{key:>7}"),
            Style::default()
                .fg(FOCUS_COLOR)
                .add_modifier(Modifier::BOLD),
        ),
        Span::raw(format!(" {desc}")),
    ])
}

fn render_add_worktree_modal(frame: &mut Frame, buffer: &str) {
    let area = frame.area().centered(
        Constraint::Length(40.min(frame.area().width.saturating_sub(4))),
        Constraint::Length(7),
    );

    frame.render_widget(Clear, area);

    let block = Block::default()
        .title(" Add Worktree ")
        .borders(Borders::ALL)
        .border_type(BorderType::Thick)
        .border_style(Style::default().fg(FOCUS_COLOR));

    let inner = block.inner(area);
    frame.render_widget(block, area);

    let lines = vec![
        Line::from(vec![
            Span::styled("Branch: ", Style::default().fg(Color::DarkGray)),
            Span::styled(
                format!("{buffer}_"),
                Style::default()
                    .fg(FOCUS_COLOR)
                    .add_modifier(Modifier::BOLD),
            ),
        ]),
        Line::raw(""),
        Line::from(vec![
            Span::styled("Enter", Style::default().fg(FOCUS_COLOR)),
            Span::raw(" create  "),
            Span::styled("Esc", Style::default().fg(FOCUS_COLOR)),
            Span::raw(" cancel"),
        ]),
    ];

    let content = Paragraph::new(lines).wrap(Wrap { trim: false });
    frame.render_widget(content, inner);
}

fn render_add_repo_modal(
    frame: &mut Frame,
    path_buffer: &str,
    pwc_buffer: &str,
    active_field: AddRepoField,
) {
    let area = frame.area().centered(
        Constraint::Length(56.min(frame.area().width.saturating_sub(4))),
        Constraint::Length(9),
    );

    frame.render_widget(Clear, area);

    let block = Block::default()
        .title(" Add Repo ")
        .borders(Borders::ALL)
        .border_type(BorderType::Thick)
        .border_style(Style::default().fg(FOCUS_COLOR));

    let inner = block.inner(area);
    frame.render_widget(block, area);

    let active_style = Style::default()
        .fg(FOCUS_COLOR)
        .add_modifier(Modifier::BOLD);
    let inactive_style = Style::default().fg(Color::DarkGray);

    let path_cursor = if active_field == AddRepoField::Path {
        "_"
    } else {
        ""
    };
    let pwc_cursor = if active_field == AddRepoField::PostWorktreeCmd {
        "_"
    } else {
        ""
    };

    let field_style = |field: AddRepoField| -> Style {
        if active_field == field {
            active_style
        } else {
            inactive_style
        }
    };

    let lines = vec![
        Line::from(vec![
            Span::styled("Path:               ", Style::default().fg(Color::DarkGray)),
            Span::styled(
                format!("{path_buffer}{path_cursor}"),
                field_style(AddRepoField::Path),
            ),
        ]),
        Line::from(vec![
            Span::styled("Post-worktree cmd:  ", Style::default().fg(Color::DarkGray)),
            Span::styled(
                format!("{pwc_buffer}{pwc_cursor}"),
                field_style(AddRepoField::PostWorktreeCmd),
            ),
        ]),
        Line::raw(""),
        Line::from(vec![
            Span::styled("Tab", Style::default().fg(FOCUS_COLOR)),
            Span::raw(" switch  "),
            Span::styled("Enter", Style::default().fg(FOCUS_COLOR)),
            Span::raw(" add  "),
            Span::styled("Esc", Style::default().fg(FOCUS_COLOR)),
            Span::raw(" cancel"),
        ]),
    ];

    let content = Paragraph::new(lines).wrap(Wrap { trim: false });
    frame.render_widget(content, inner);
}

fn render_confirm_add_repo_modal(frame: &mut Frame, repo_path: &std::path::Path) {
    let name = repo_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("?");

    let area = frame.area().centered(
        Constraint::Length(40.min(frame.area().width.saturating_sub(2))),
        Constraint::Length(6),
    );

    frame.render_widget(Clear, area);

    let block = Block::default()
        .title(" New Repo ")
        .borders(Borders::ALL)
        .border_type(BorderType::Thick)
        .border_style(Style::default().fg(FOCUS_COLOR));

    let inner = block.inner(area);
    frame.render_widget(block, area);

    let lines = vec![
        Line::from(vec![
            Span::raw("Add "),
            Span::styled(
                name,
                Style::default()
                    .fg(FOCUS_COLOR)
                    .add_modifier(Modifier::BOLD),
            ),
            Span::raw("?"),
        ]),
        Line::raw(""),
        Line::from(vec![
            Span::styled("y", Style::default().fg(FOCUS_COLOR)),
            Span::raw("/"),
            Span::styled("Enter", Style::default().fg(FOCUS_COLOR)),
            Span::raw(" yes  "),
            Span::styled("n", Style::default().fg(FOCUS_COLOR)),
            Span::raw("/"),
            Span::styled("Esc", Style::default().fg(FOCUS_COLOR)),
            Span::raw(" no"),
        ]),
    ];

    let content = Paragraph::new(lines).wrap(Wrap { trim: false });
    frame.render_widget(content, inner);
}

fn render_new_repo_pwc_modal(frame: &mut Frame, buffer: &str) {
    let area = frame.area().centered(
        Constraint::Length(46.min(frame.area().width.saturating_sub(2))),
        Constraint::Length(7),
    );

    frame.render_widget(Clear, area);

    let block = Block::default()
        .title(" New Worktree Command ")
        .borders(Borders::ALL)
        .border_type(BorderType::Thick)
        .border_style(Style::default().fg(FOCUS_COLOR));

    let inner = block.inner(area);
    frame.render_widget(block, area);

    let lines = vec![
        Line::from(Span::styled(
            "Run after creating a worktree:",
            Style::default().fg(Color::DarkGray),
        )),
        Line::from(Span::styled(
            format!("{buffer}_"),
            Style::default()
                .fg(FOCUS_COLOR)
                .add_modifier(Modifier::BOLD),
        )),
        Line::raw(""),
        Line::from(vec![
            Span::styled("Enter", Style::default().fg(FOCUS_COLOR)),
            Span::raw(" save  "),
            Span::styled("Esc", Style::default().fg(FOCUS_COLOR)),
            Span::raw(" skip"),
        ]),
    ];

    let content = Paragraph::new(lines).wrap(Wrap { trim: false });
    frame.render_widget(content, inner);
}
