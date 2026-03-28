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

    let update_row = if app.update_pending() { 1 } else { 0 };

    let vertical = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Min(3),
            Constraint::Length(update_row),
            Constraint::Length(1),
        ])
        .split(area);

    let main_area = vertical[0];
    let update_area = vertical[1];
    let status_area = vertical[2];

    render_folder_list(frame, app, main_area);
    if app.update_pending() {
        render_update_banner(frame, update_area);
    }
    render_status_bar(frame, app, status_area);

    // Render modal on top of everything.
    match app.modal() {
        Modal::Settings {
            ai_cmd_buffer,
            post_worktree_cmd_buffer,
            auto_update,
            active_field,
        } => {
            render_settings_modal(
                frame,
                ai_cmd_buffer,
                post_worktree_cmd_buffer,
                *auto_update,
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
        Modal::ConfirmRemoveRepo { repo_path } => {
            render_confirm_remove_repo_modal(frame, repo_path);
        }
        Modal::ConfirmClosePanes { folder } => {
            render_confirm_close_panes_modal(frame, folder);
        }
        Modal::ConfirmAddNewRepo { repo_path } => {
            render_confirm_add_repo_modal(frame, repo_path);
        }
        Modal::NewRepoPostWorktreeCmd { repo_path, buffer } => {
            let global_pwc = app.config().post_worktree_cmd.as_deref().unwrap_or("(none)");
            let repo_name = repo_path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("?");
            render_new_repo_pwc_modal(frame, buffer, repo_name, global_pwc);
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
    is_shell_pane: bool,
) -> (char, Color) {
    if !tmux.is_pane_alive(pane_id) {
        ('x', Color::Red)
    } else if tmux.is_pane_busy(pane_id, threshold_secs, is_shell_pane) {
        (spinner_char(), Color::Green)
    } else {
        ('-', Color::DarkGray)
    }
}

/// Wraps sidebar entry text with hanging indent. Continuation lines are
/// indented 2 spaces past where the name starts on the first line.
fn wrap_sidebar_entry<'a>(
    prefix_spans: Vec<Span<'a>>,
    name: &str,
    name_style: Style,
    suffix: &str,
    line_style: Style,
    prefix_width: usize,
    area_width: usize,
) -> Vec<Line<'a>> {
    let full_text = format!("{name}{suffix}");
    let first_avail = area_width.saturating_sub(prefix_width);

    if full_text.len() <= first_avail {
        let mut spans = prefix_spans;
        spans.push(Span::styled(full_text, name_style));
        return vec![Line::from(spans).style(line_style)];
    }

    let cont_indent = prefix_width + 2;
    let cont_avail = area_width.saturating_sub(cont_indent).max(1);
    let mut lines: Vec<Line> = Vec::new();
    let mut chars = full_text.chars();

    // First line.
    let first_chunk: String = chars.by_ref().take(first_avail).collect();
    let mut spans = prefix_spans;
    spans.push(Span::styled(first_chunk, name_style));
    lines.push(Line::from(spans).style(line_style));

    // Continuation lines.
    loop {
        let chunk: String = chars.by_ref().take(cont_avail).collect();
        if chunk.is_empty() {
            break;
        }
        lines.push(
            Line::from(vec![
                Span::raw(" ".repeat(cont_indent)),
                Span::styled(chunk, name_style),
            ])
            .style(line_style),
        );
    }

    lines
}

fn render_folder_list(frame: &mut Frame, app: &App, area: ratatui::layout::Rect) {
    use crate::pane::folder_list::{GitStatus, SidebarEntry};

    let focused = app.tmux().is_sidebar_focused();
    let inner = area;

    let selected_entry_idx = app.folder_list().selected_entry_index();
    let active_folder = app.active_folder();
    let active_entry_idx = app
        .folder_list()
        .entries()
        .iter()
        .position(|e| e.is_selectable() && Some(e.path()) == active_folder.map(|p| p.as_path()));

    let width = inner.width as usize;
    let lines: Vec<Line> = app
        .folder_list()
        .entries()
        .iter()
        .enumerate()
        .flat_map(|(idx, entry)| {
            match entry {
                SidebarEntry::RepoHeader { name, .. } => wrap_sidebar_entry(
                    vec![Span::raw("  ")],
                    name,
                    Style::default()
                        .fg(Color::DarkGray)
                        .add_modifier(Modifier::BOLD),
                    "",
                    Style::default(),
                    2,
                    width,
                ),
                SidebarEntry::Item {
                    path,
                    name,
                    indented,
                    ..
                } => {
                    let is_selected = selected_entry_idx == Some(idx);
                    let is_active = active_entry_idx == Some(idx);
                    let highlighted = (focused && is_selected) || is_active;

                    let mut prefix_spans: Vec<Span> = Vec::new();
                    let mut prefix_width: usize = 0;

                    if *indented {
                        prefix_spans.push(Span::raw("  "));
                        prefix_width += 2;
                    }

                    // Pane status indicators (2 display columns).
                    if let Some(session) = app.tmux().session_for(path) {
                        let tmux = app.tmux();
                        let (ai_ch, ai_color) = match &session.ai_pane_id {
                            Some(ai_id) => pane_char_color(
                                tmux,
                                ai_id,
                                AI_BUSY_THRESHOLD_SECS,
                                false,
                            ),
                            None => (' ', Color::DarkGray),
                        };
                        let (sh_ch, sh_color) = pane_char_color(
                            tmux,
                            &session.shell_pane_id,
                            SHELL_BUSY_THRESHOLD_SECS,
                            true,
                        );
                        let (ai_color, sh_color) = if focused {
                            (ai_color, sh_color)
                        } else {
                            (Color::DarkGray, Color::DarkGray)
                        };
                        if highlighted {
                            prefix_spans.push(Span::raw(format!("{ai_ch}{sh_ch}")));
                        } else if ai_color == sh_color {
                            prefix_spans.push(Span::styled(
                                format!("{ai_ch}{sh_ch}"),
                                Style::default().fg(ai_color),
                            ));
                        } else {
                            prefix_spans.push(Span::styled(
                                format!("{ai_ch}"),
                                Style::default().fg(ai_color),
                            ));
                            prefix_spans.push(Span::styled(
                                format!("{sh_ch}"),
                                Style::default().fg(sh_color),
                            ));
                        }
                    } else {
                        prefix_spans.push(Span::raw("  "));
                    }
                    prefix_width += 2;

                    let suffix = match app.folder_list().git_status(path) {
                        GitStatus::Dirty => "*",
                        GitStatus::Unpushed => "+",
                        GitStatus::Clean => "",
                    };

                    let style = if focused && is_selected {
                        Style::new().add_modifier(Modifier::REVERSED | Modifier::BOLD)
                    } else if is_active {
                        Style::new()
                            .fg(Color::DarkGray)
                            .add_modifier(Modifier::REVERSED)
                    } else if !focused {
                        Style::new().fg(Color::DarkGray)
                    } else {
                        Style::new()
                    };

                    let has_pr = app.folder_list().pr_info(path).is_some();
                    let name_style = if has_pr {
                        Style::default().add_modifier(Modifier::UNDERLINED)
                    } else {
                        Style::default()
                    };

                    wrap_sidebar_entry(
                        prefix_spans,
                        name,
                        name_style,
                        suffix,
                        style,
                        prefix_width,
                        width,
                    )
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

fn render_update_banner(frame: &mut Frame, area: ratatui::layout::Rect) {
    let style = Style::default()
        .fg(Color::Black)
        .bg(Color::Rgb(255, 165, 0));
    let bar = Paragraph::new(Span::styled(" restart to update", style));
    frame.render_widget(bar, area);
}

fn render_settings_modal(
    frame: &mut Frame,
    ai_cmd_buffer: &str,
    post_worktree_cmd_buffer: &str,
    auto_update: bool,
    active_field: SettingsField,
) {
    let area = frame.area().centered(
        Constraint::Length(56.min(frame.area().width.saturating_sub(4))),
        Constraint::Length(11),
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

    let cursor = |field: SettingsField| -> &str {
        if active_field == field { "_" } else { "" }
    };

    let field_style = |field: SettingsField| -> Style {
        if active_field == field {
            active_style
        } else {
            inactive_style
        }
    };

    let auto_update_label = if auto_update { "on" } else { "off" };

    let lines = vec![
        Line::from(vec![
            Span::styled("AI command:         ", Style::default().fg(Color::DarkGray)),
            Span::styled(
                format!("{ai_cmd_buffer}{}", cursor(SettingsField::AiCmd)),
                field_style(SettingsField::AiCmd),
            ),
        ]),
        Line::from(vec![
            Span::styled("Post-worktree cmd:  ", Style::default().fg(Color::DarkGray)),
            Span::styled(
                format!(
                    "{post_worktree_cmd_buffer}{}",
                    cursor(SettingsField::PostWorktreeCmd)
                ),
                field_style(SettingsField::PostWorktreeCmd),
            ),
        ]),
        Line::from(vec![
            Span::styled("Auto-update:        ", Style::default().fg(Color::DarkGray)),
            Span::styled(auto_update_label, field_style(SettingsField::AutoUpdate)),
            Span::styled(
                if active_field == SettingsField::AutoUpdate {
                    "  (Space to toggle)"
                } else {
                    ""
                },
                Style::default().fg(Color::DarkGray),
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
        help_line("i", "Toggle AI pane"),
        help_line("x", "Restart dead panes"),
        help_line("c", "Close panes"),
        help_line("g", "Open PR"),
    ];

    if !is_lone {
        lines.push(help_line("a", "Add repo"));
        lines.push(help_line("Bksp", "Remove repo"));
        lines.push(help_line("o", "Open config"));
    }

    lines.extend([
        help_line("^Q", "Quit"),
        help_line("Alt+S", "Settings"),
        Line::raw(""),
        help_line("Alt+1/2/3", "Focus pane"),
        help_line("Alt+F", "Zoom pane"),
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

fn render_new_repo_pwc_modal(
    frame: &mut Frame,
    buffer: &str,
    repo_name: &str,
    global_pwc: &str,
) {
    let area = frame.area().centered(
        Constraint::Length(56.min(frame.area().width.saturating_sub(2))),
        Constraint::Length(10),
    );

    frame.render_widget(Clear, area);

    let block = Block::default()
        .title(format!(" Worktree Cmd: {repo_name} "))
        .borders(Borders::ALL)
        .border_type(BorderType::Thick)
        .border_style(Style::default().fg(FOCUS_COLOR));

    let inner = block.inner(area);
    frame.render_widget(block, area);

    let lines = vec![
        Line::from(vec![
            Span::styled("Global default: ", Style::default().fg(Color::DarkGray)),
            Span::styled(global_pwc, Style::default().fg(Color::DarkGray)),
        ]),
        Line::from(Span::styled(
            "Leave blank to use global default.",
            Style::default().fg(Color::DarkGray),
        )),
        Line::raw(""),
        Line::from(vec![
            Span::styled("Command: ", Style::default().fg(Color::DarkGray)),
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
            Span::raw(" save  "),
            Span::styled("Esc", Style::default().fg(FOCUS_COLOR)),
            Span::raw(" skip"),
        ]),
    ];

    let content = Paragraph::new(lines).wrap(Wrap { trim: false });
    frame.render_widget(content, inner);
}

fn render_confirm_close_panes_modal(frame: &mut Frame, folder: &std::path::Path) {
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
        .title(" Close Panes ")
        .borders(Borders::ALL)
        .border_type(BorderType::Thick)
        .border_style(Style::default().fg(Color::Yellow));

    let inner = block.inner(area);
    frame.render_widget(block, area);

    let lines = vec![
        Line::from(vec![
            Span::raw("Close panes for "),
            Span::styled(
                name,
                Style::default()
                    .fg(Color::Yellow)
                    .add_modifier(Modifier::BOLD),
            ),
            Span::raw("?"),
        ]),
        Line::raw(""),
        Line::from(vec![
            Span::styled(
                "y",
                Style::default()
                    .fg(Color::Yellow)
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

fn render_confirm_remove_repo_modal(frame: &mut Frame, repo_path: &std::path::Path) {
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
        .title(" Remove Repo ")
        .borders(Borders::ALL)
        .border_type(BorderType::Thick)
        .border_style(Style::default().fg(Color::Red));

    let inner = block.inner(area);
    frame.render_widget(block, area);

    let lines = vec![
        Line::from(vec![
            Span::raw("Remove "),
            Span::styled(
                name,
                Style::default()
                    .fg(Color::Red)
                    .add_modifier(Modifier::BOLD),
            ),
            Span::raw(" from repos?"),
        ]),
        Line::raw(""),
        Line::from(vec![
            Span::styled("y", Style::default().fg(Color::Red).add_modifier(Modifier::BOLD)),
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
