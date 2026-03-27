use crate::app::{App, Focus, FolderMode, Modal, SettingsField};
use ratatui::layout::{Constraint, Direction, Layout, Spacing};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{
    Block, BorderType, Borders, Clear, List, ListItem, ListState, Paragraph, Wrap,
};
use ratatui::Frame;
use std::time::{SystemTime, UNIX_EPOCH};

const SPINNER_FRAMES: &[char] = &['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

const FOCUS_COLOR: Color = Color::LightCyan;
const UNFOCUS_COLOR: Color = Color::DarkGray;
const BRIGHT_WHITE: Color = Color::Rgb(255, 255, 255);

/// Column boundaries returned after rendering, used for mouse hit-testing.
pub struct ColumnRects {
    pub folder_list: ratatui::layout::Rect,
    pub claude_pane: ratatui::layout::Rect,
    pub shell_pane: ratatui::layout::Rect,
}

pub fn render(frame: &mut Frame, app: &App) -> ColumnRects {
    let area = frame.area();

    // Split into main area + status bar at the bottom.
    let vertical = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Min(3), Constraint::Length(1)])
        .split(area);

    let main_area = vertical[0];
    let status_area = vertical[1];

    let session = app.active_session();
    let ai_pane = session.map(|s| &s.ai_pane);
    let shell_pane = session.map(|s| &s.shell_pane);

    let folder_name = app.active_folder_name().unwrap_or("");
    let ai_title = if folder_name.is_empty() {
        "AI".to_string()
    } else {
        format!("AI ({folder_name})")
    };
    let shell_title = if folder_name.is_empty() {
        "shell".to_string()
    } else {
        format!("shell ({folder_name})")
    };

    // Fullscreen: render only the focused pane.
    if app.is_fullscreen() {
        let title = match app.focus() {
            Focus::ClaudePane => &ai_title,
            Focus::ShellPane => &shell_title,
            Focus::FolderList => "Folders",
        };
        let pane = match app.focus() {
            Focus::ClaudePane => ai_pane,
            Focus::ShellPane => shell_pane,
            Focus::FolderList => None,
        };
        render_pty_pane(frame, app, main_area, title, app.focus(), pane);
        render_status_bar(frame, app, status_area);

        return ColumnRects {
            folder_list: ratatui::layout::Rect::default(),
            claude_pane: if app.focus() == Focus::ClaudePane {
                main_area
            } else {
                ratatui::layout::Rect::default()
            },
            shell_pane: if app.focus() == Focus::ShellPane {
                main_area
            } else {
                ratatui::layout::Rect::default()
            },
        };
    }

    let columns = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([
            Constraint::Min(24),
            Constraint::Percentage(40),
            Constraint::Percentage(40),
        ])
        .spacing(Spacing::Overlap(1))
        .split(main_area);

    render_folder_list(frame, app, columns[0]);
    render_pty_pane(frame, app, columns[1], &ai_title, Focus::ClaudePane, ai_pane);
    render_pty_pane(frame, app, columns[2], &shell_title, Focus::ShellPane, shell_pane);
    render_status_bar(frame, app, status_area);

    // Render modal on top of everything.
    match app.modal() {
        Modal::Settings {
            ai_cmd_buffer,
            post_worktree_cmd_buffer,
            no_mouse,
            active_field,
        } => {
            render_settings_modal(
                frame,
                ai_cmd_buffer,
                post_worktree_cmd_buffer,
                *no_mouse,
                *active_field,
            );
        }
        Modal::ConfirmDeleteWorktree { folder } => {
            render_confirm_delete_modal(frame, folder);
        }
        Modal::None => {}
    }

    ColumnRects {
        folder_list: columns[0],
        claude_pane: columns[1],
        shell_pane: columns[2],
    }
}

fn pane_block(title: Line<'_>, focused: bool) -> Block<'_> {
    let border_type = if focused {
        BorderType::Thick
    } else {
        BorderType::Plain
    };
    let border_color = if focused {
        FOCUS_COLOR
    } else {
        UNFOCUS_COLOR
    };

    Block::default()
        .title(title)
        .borders(Borders::ALL)
        .border_type(border_type)
        .border_style(Style::default().fg(border_color))
}

fn spinner_char() -> char {
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let idx = (ms / 100) as usize % SPINNER_FRAMES.len();
    SPINNER_FRAMES[idx]
}

/// Returns styled spans showing per-pane status for a folder.
///   `   ` = no session
///   Two chars: [AI][Shell], each one of:
///     spinner (green) = busy (recent output)
///     `-` (dim)       = idle (alive, no recent output)
///     `x` (red)       = exited
const AI_BUSY_THRESHOLD_MS: u128 = 1_000;
const SHELL_BUSY_THRESHOLD_MS: u128 = 5_000;

fn pane_status_indicators<'a>(app: &App, folder: &std::path::PathBuf) -> Vec<Span<'a>> {
    let Some(session) = app.session_for(folder) else {
        return vec![Span::raw("   ")];
    };

    fn char_and_color(pane: &crate::pane::pty_pane::PtyPane, threshold_ms: u128) -> (char, Color) {
        if !pane.is_alive() {
            ('x', Color::Red)
        } else if pane.is_busy(threshold_ms) {
            (spinner_char(), Color::Green)
        } else {
            ('-', Color::DarkGray)
        }
    }

    let (ai_ch, ai_color) = char_and_color(&session.ai_pane, AI_BUSY_THRESHOLD_MS);
    let (sh_ch, sh_color) = char_and_color(&session.shell_pane, SHELL_BUSY_THRESHOLD_MS);

    vec![
        Span::styled(format!("{ai_ch}"), Style::default().fg(ai_color)),
        Span::styled(format!("{sh_ch}"), Style::default().fg(sh_color)),
        Span::raw(" "),
    ]
}

fn render_folder_list(frame: &mut Frame, app: &App, area: ratatui::layout::Rect) {
    let focused = app.focus() == Focus::FolderList;

    let mut title_parts = vec![Span::raw(" Folders ")];
    if app.is_worktree_root() {
        title_parts.push(Span::styled(
            "[w]orktree ",
            Style::default().fg(Color::Yellow),
        ));
    }

    let block = pane_block(Line::from(title_parts), focused);

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

            // When focused: if this is the active folder but NOT the highlighted
            // one, show it with a grey inversed style.
            let is_active = active_index == Some(idx);
            if focused && is_active && idx != selected_index {
                spans.push(Span::raw(name));
                return ListItem::new(Line::from(spans)).style(
                    Style::new()
                        .fg(Color::DarkGray)
                        .add_modifier(Modifier::REVERSED),
                );
            }

            spans.push(Span::raw(name));
            ListItem::new(Line::from(spans))
        })
        .collect();

    // When focused: highlight the selected (navigated) folder.
    // When unfocused: highlight the active folder instead.
    let highlight_style = if focused {
        Style::new().add_modifier(Modifier::REVERSED | Modifier::BOLD)
    } else {
        Style::new()
            .fg(Color::DarkGray)
            .add_modifier(Modifier::REVERSED)
    };

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

fn render_pty_pane(
    frame: &mut Frame,
    app: &App,
    area: ratatui::layout::Rect,
    title: &str,
    pane_focus: Focus,
    pane: Option<&crate::pane::pty_pane::PtyPane>,
) {
    let focused = app.focus() == pane_focus;
    let borderless = app.is_fullscreen() && focused;

    let status = match pane {
        Some(p) if p.is_alive() => "",
        Some(_) => " [exited]",
        None => " [none]",
    };

    match pane {
        Some(pane) => {
            let screen = pane.screen();
            let no_cursor = tui_term::widget::Cursor::default().visibility(false);
            let mut pseudo_term =
                tui_term::widget::PseudoTerminal::new(&screen).cursor(no_cursor);

            let border_offset = if borderless { 0 } else { 1 };

            if !borderless {
                let block =
                    pane_block(Line::from(format!(" {title}{status} ")), focused);
                pseudo_term = pseudo_term.block(block);
            }

            frame.render_widget(pseudo_term, area);

            // Place the real hardware cursor so the user's native cursor style shows.
            if focused && !screen.hide_cursor() {
                let (c_row, c_col) = screen.cursor_position();
                let cursor_x = area.x + border_offset + c_col;
                let cursor_y = area.y + border_offset + c_row;
                let max_x = area.x + area.width.saturating_sub(border_offset);
                let max_y = area.y + area.height.saturating_sub(border_offset);
                if cursor_x < max_x && cursor_y < max_y {
                    frame.set_cursor_position((cursor_x, cursor_y));
                }
            }
        }
        None => {
            let block =
                pane_block(Line::from(format!(" {title}{status} ")), focused);
            let msg = Paragraph::new("Press Enter on a folder to start.").block(block);
            frame.render_widget(msg, area);
        }
    }
}

fn render_status_bar(frame: &mut Frame, app: &App, area: ratatui::layout::Rect) {
    let status_text = match app.folder_mode() {
        FolderMode::WorktreeInput { buffer } => {
            format!("New worktree branch: {buffer}_")
        }
        FolderMode::Normal => {
            if let Some(msg) = app.status_message() {
                msg.to_string()
            } else {
                let focus_hint = match app.focus() {
                    Focus::FolderList => "Folders",
                    Focus::ClaudePane => "AI",
                    Focus::ShellPane => "Shell",
                };
                let worktree_hint =
                    if app.is_worktree_root() && app.focus() == Focus::FolderList {
                        " | w: add | d: delete worktree"
                    } else {
                        ""
                    };
                let mouse_hint = if app.mouse_capture() {
                    "Alt+M: mouse off"
                } else {
                    "Alt+M: mouse on"
                };
                let fullscreen_hint = if app.is_fullscreen() {
                    " | Alt+F: exit fullscreen"
                } else if app.focus() != Focus::FolderList {
                    " | Alt+F: fullscreen"
                } else {
                    ""
                };
                format!(
                    " [{focus_hint}] Alt+1/2/3: switch | Alt+S: settings | {mouse_hint}{fullscreen_hint} | Ctrl+Q: quit{worktree_hint}"
                )
            }
        }
    };

    let style = Style::default().fg(Color::White).bg(Color::DarkGray);

    // Manually fill every cell to prevent overlap artifacts from pane borders.
    let buf = frame.buffer_mut();
    for x in area.x..area.x + area.width {
        for y in area.y..area.y + area.height {
            let cell = &mut buf[(x, y)];
            cell.reset();
            cell.set_style(style);
        }
    }

    let bar = Paragraph::new(Span::styled(status_text, style));
    frame.render_widget(bar, area);
}

fn render_settings_modal(
    frame: &mut Frame,
    ai_cmd_buffer: &str,
    post_worktree_cmd_buffer: &str,
    no_mouse: bool,
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
        .fg(BRIGHT_WHITE)
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

    let checkbox = if no_mouse { "[x]" } else { "[ ]" };
    let mouse_hint = if active_field == SettingsField::NoMouse {
        " (Space to toggle)"
    } else {
        ""
    };

    let lines = vec![
        Line::from(vec![
            Span::styled("AI command:         ", Style::default().fg(Color::DarkGray)),
            Span::styled(format!("{ai_cmd_buffer}{ai_cursor}"), field_style(SettingsField::AiCmd)),
        ]),
        Line::from(vec![
            Span::styled("Post-worktree cmd:  ", Style::default().fg(Color::DarkGray)),
            Span::styled(
                format!("{post_worktree_cmd_buffer}{pwc_cursor}"),
                field_style(SettingsField::PostWorktreeCmd),
            ),
        ]),
        Line::from(vec![
            Span::styled("Start without mouse:", Style::default().fg(Color::DarkGray)),
            Span::raw(" "),
            Span::styled(format!("{checkbox}{mouse_hint}"), field_style(SettingsField::NoMouse)),
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
            Span::styled(name, Style::default().fg(Color::Red).add_modifier(Modifier::BOLD)),
            Span::raw("?"),
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
