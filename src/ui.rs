use crate::app::{App, Focus, FolderMode};
use ratatui::layout::{Constraint, Direction, Layout};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, List, ListItem, ListState, Paragraph};
use ratatui::Frame;

pub fn render(frame: &mut Frame, app: &App) {
    let area = frame.area();

    // Split into main area + status bar at the bottom.
    let vertical = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Min(3), Constraint::Length(1)])
        .split(area);

    let main_area = vertical[0];
    let status_area = vertical[1];

    let columns = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([
            Constraint::Min(24),
            Constraint::Percentage(40),
            Constraint::Percentage(40),
        ])
        .split(main_area);

    render_folder_list(frame, app, columns[0]);
    render_pty_pane(frame, app, columns[1], app.ai_cmd(), Focus::ClaudePane);
    render_pty_pane(frame, app, columns[2], "shell", Focus::ShellPane);
    render_status_bar(frame, app, status_area);
}

fn render_folder_list(frame: &mut Frame, app: &App, area: ratatui::layout::Rect) {
    let focused = app.focus() == Focus::FolderList;
    let border_color = if focused {
        Color::LightMagenta
    } else {
        Color::DarkGray
    };

    let mut title_parts = vec![Span::raw(" Folders ")];
    if app.is_worktree_root() {
        title_parts.push(Span::styled(
            "[w]orktree ",
            Style::default().fg(Color::Yellow),
        ));
    }

    let block = Block::default()
        .title(Line::from(title_parts))
        .borders(Borders::ALL)
        .border_style(Style::default().fg(border_color));

    let items: Vec<ListItem> = app
        .folder_list()
        .folders()
        .iter()
        .map(|path| {
            let name = path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("?");
            ListItem::new(Line::from(Span::raw(format!(" {name}"))))
        })
        .collect();

    let mut state = ListState::default().with_selected(Some(app.folder_list().selected_index()));

    let list = List::new(items)
        .block(block)
        .highlight_style(
            Style::default()
                .fg(Color::Black)
                .bg(Color::LightMagenta)
                .add_modifier(Modifier::BOLD),
        );

    frame.render_stateful_widget(list, area, &mut state);
}

fn render_pty_pane(
    frame: &mut Frame,
    app: &App,
    area: ratatui::layout::Rect,
    title: &str,
    pane_focus: Focus,
) {
    let focused = app.focus() == pane_focus;
    let border_color = if focused {
        Color::LightMagenta
    } else {
        Color::DarkGray
    };

    let pane = match pane_focus {
        Focus::ClaudePane => app.claude_pane(),
        Focus::ShellPane => app.shell_pane(),
        Focus::FolderList => unreachable!(),
    };

    let status = match pane {
        Some(p) if p.is_alive() => "",
        Some(_) => " [exited]",
        None => " [none]",
    };

    let block = Block::default()
        .title(format!(" {title}{status} "))
        .borders(Borders::ALL)
        .border_style(Style::default().fg(border_color));

    match pane {
        Some(pane) => {
            let screen = pane.screen();
            let pseudo_term = tui_term::widget::PseudoTerminal::new(&screen).block(block);
            frame.render_widget(pseudo_term, area);

            // Render cursor if focused.
            if focused {
                let cursor = screen.cursor_position();
                let inner = block_inner(area);
                let cursor_x = inner.x + cursor.1;
                let cursor_y = inner.y + cursor.0;
                if cursor_x < inner.x + inner.width && cursor_y < inner.y + inner.height {
                    frame.set_cursor_position((cursor_x, cursor_y));
                }
            }
        }
        None => {
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
                format!(
                    " [{focus_hint}] Ctrl+1/2/3: switch pane | Ctrl+Q: quit{}",
                    if app.is_worktree_root() {
                        " | w: add worktree"
                    } else {
                        ""
                    }
                )
            }
        }
    };

    let bar = Paragraph::new(status_text).style(
        Style::default()
            .fg(Color::White)
            .bg(Color::DarkGray),
    );
    frame.render_widget(bar, area);
}

/// Calculate the inner area of a block with all borders.
fn block_inner(area: ratatui::layout::Rect) -> ratatui::layout::Rect {
    ratatui::layout::Rect {
        x: area.x + 1,
        y: area.y + 1,
        width: area.width.saturating_sub(2),
        height: area.height.saturating_sub(2),
    }
}
