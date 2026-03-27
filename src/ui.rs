use crate::app::{App, FolderMode, Modal, SettingsField};
use ratatui::layout::{Constraint, Direction, Layout};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{
    Block, BorderType, Borders, Clear, List, ListItem, ListState, Paragraph, Wrap,
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
        Modal::ConfirmDeleteWorktree { folder } => {
            render_confirm_delete_modal(frame, folder);
        }
        Modal::Help => {
            render_help_modal(frame, app.is_worktree_root());
        }
        Modal::None => {}
    }
}

/// Returns styled spans showing per-pane status for a folder.
fn pane_status_indicators<'a>(app: &App, folder: &std::path::Path) -> Vec<Span<'a>> {
    let Some(session) = app.tmux().session_for(folder) else {
        return vec![Span::raw("   ")];
    };

    let tmux = app.tmux();

    fn char_and_color(
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

    let (ai_ch, ai_color) = char_and_color(tmux, &session.ai_pane_id, AI_BUSY_THRESHOLD_SECS);
    let (sh_ch, sh_color) =
        char_and_color(tmux, &session.shell_pane_id, SHELL_BUSY_THRESHOLD_SECS);

    vec![
        Span::styled(format!("{ai_ch}"), Style::default().fg(ai_color)),
        Span::styled(format!("{sh_ch}"), Style::default().fg(sh_color)),
        Span::raw(" "),
    ]
}

fn render_folder_list(frame: &mut Frame, app: &App, area: ratatui::layout::Rect) {
    let focused = app.tmux().is_sidebar_focused();

    let mut title_parts = vec![Span::raw(" Folders ")];
    if app.is_worktree_root() {
        title_parts.push(Span::styled(
            "[w]orktree ",
            Style::default().fg(Color::Yellow),
        ));
    }

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
        .title(Line::from(title_parts))
        .borders(Borders::ALL)
        .border_type(border_type)
        .border_style(Style::default().fg(border_color));

    let selected_index = app.folder_list().selected_index();
    let active_folder = app.active_folder();
    let active_index = app
        .folder_list()
        .folders()
        .iter()
        .position(|f| Some(f) == active_folder);

    let items: Vec<ListItem> = app
        .folder_list()
        .folders()
        .iter()
        .enumerate()
        .map(|(idx, path)| {
            let name = path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("?");
            let mut spans = pane_status_indicators(app, path);
            spans.push(Span::raw(name));
            match app.folder_list().git_status(path) {
                crate::pane::folder_list::GitStatus::Dirty => {
                    spans.push(Span::raw("*"));
                }
                crate::pane::folder_list::GitStatus::Unpushed => {
                    spans.push(Span::raw("+"));
                }
                crate::pane::folder_list::GitStatus::Clean => {}
            }

            let is_active = active_index == Some(idx);
            // If this is the active folder but NOT the highlighted one,
            // show it with a grey inversed style.
            if focused && is_active && idx != selected_index {
                return ListItem::new(Line::from(spans)).style(
                    Style::new()
                        .fg(Color::DarkGray)
                        .add_modifier(Modifier::REVERSED),
                );
            }

            ListItem::new(Line::from(spans))
        })
        .collect();

    let highlight_style = if focused {
        Style::new().add_modifier(Modifier::REVERSED | Modifier::BOLD)
    } else {
        Style::new()
            .fg(Color::DarkGray)
            .add_modifier(Modifier::REVERSED)
    };

    // When unfocused, show the active folder instead of the navigation cursor.
    let shown_selection = if focused {
        Some(selected_index)
    } else {
        active_index
    };

    let mut state = ListState::default().with_selected(shown_selection);

    let list = List::new(items)
        .block(block)
        .highlight_style(highlight_style);

    frame.render_stateful_widget(list, area, &mut state);
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

fn render_help_modal(frame: &mut Frame, is_worktree: bool) {
    let mut lines = vec![
        help_line("Enter", "Open + focus AI"),
        help_line("Tab", "Open + stay"),
        help_line("j/k", "Navigate"),
        help_line("r", "Rename"),
        help_line("x", "Restart dead panes"),
        help_line("^Q", "Quit"),
        help_line("M-S", "Settings"),
        Line::raw(""),
        help_line("M-1/2/3", "Focus pane"),
        help_line("M-F", "Zoom pane"),
    ];

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
