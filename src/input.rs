use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

/// Translates a crossterm KeyEvent into the raw bytes a terminal would send.
/// Handles modifier combinations (Shift, Alt, Ctrl) for arrow keys and other
/// special keys using standard xterm-style CSI sequences.
pub fn key_event_to_bytes(key: &KeyEvent) -> Option<Vec<u8>> {
    let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
    let alt = key.modifiers.contains(KeyModifiers::ALT);
    let shift = key.modifiers.contains(KeyModifiers::SHIFT);

    // Compute the xterm modifier parameter (1 + bitmask).
    // Shift=1, Alt=2, Ctrl=4 → parameter = 1 + sum.
    let modifier_bits = (shift as u8) | ((alt as u8) << 1) | ((ctrl as u8) << 2);

    match key.code {
        // Ctrl+letter produces control codes 1-26.
        KeyCode::Char(c) if ctrl && !alt => {
            let byte = (c.to_ascii_lowercase() as u8)
                .wrapping_sub(b'a')
                .wrapping_add(1);
            Some(vec![byte])
        }
        // Alt+letter sends ESC followed by the character.
        KeyCode::Char(c) if alt => {
            let mut bytes = vec![0x1b];
            let mut buf = [0u8; 4];
            let s = c.encode_utf8(&mut buf);
            bytes.extend_from_slice(s.as_bytes());
            Some(bytes)
        }
        KeyCode::Char(c) => {
            let mut buf = [0u8; 4];
            let s = c.encode_utf8(&mut buf);
            Some(s.as_bytes().to_vec())
        }
        KeyCode::Enter => Some(vec![b'\r']),
        KeyCode::Backspace => Some(vec![0x7f]),
        KeyCode::Tab => Some(vec![b'\t']),
        KeyCode::BackTab => Some(b"\x1b[Z".to_vec()),
        KeyCode::Esc => Some(vec![0x1b]),
        KeyCode::Null => Some(vec![0x00]),

        // Arrow keys with modifier support.
        KeyCode::Up => Some(csi_with_modifier(b'A', modifier_bits)),
        KeyCode::Down => Some(csi_with_modifier(b'B', modifier_bits)),
        KeyCode::Right => Some(csi_with_modifier(b'C', modifier_bits)),
        KeyCode::Left => Some(csi_with_modifier(b'D', modifier_bits)),
        KeyCode::Home => Some(csi_with_modifier(b'H', modifier_bits)),
        KeyCode::End => Some(csi_with_modifier(b'F', modifier_bits)),

        // Tilde-style keys with modifier support.
        KeyCode::Insert => Some(tilde_with_modifier(2, modifier_bits)),
        KeyCode::Delete => Some(tilde_with_modifier(3, modifier_bits)),
        KeyCode::PageUp => Some(tilde_with_modifier(5, modifier_bits)),
        KeyCode::PageDown => Some(tilde_with_modifier(6, modifier_bits)),

        KeyCode::F(n) => f_key_bytes(n, modifier_bits),

        // Pass through anything else we don't recognize.
        _ => None,
    }
}

/// Generates `ESC[<final>` or `ESC[1;<mod><final>` for arrow/home/end keys.
fn csi_with_modifier(final_byte: u8, modifier_bits: u8) -> Vec<u8> {
    if modifier_bits == 0 {
        vec![0x1b, b'[', final_byte]
    } else {
        format!("\x1b[1;{}{}", 1 + modifier_bits, final_byte as char).into_bytes()
    }
}

/// Generates `ESC[<num>~` or `ESC[<num>;<mod>~` for insert/delete/pgup/pgdn.
fn tilde_with_modifier(num: u8, modifier_bits: u8) -> Vec<u8> {
    if modifier_bits == 0 {
        format!("\x1b[{num}~").into_bytes()
    } else {
        format!("\x1b[{num};{}~", 1 + modifier_bits).into_bytes()
    }
}

fn f_key_bytes(n: u8, modifier_bits: u8) -> Option<Vec<u8>> {
    // F1-F4 use SS3 sequences without modifiers, CSI with modifiers.
    // F5-F12 use tilde sequences.
    let (num, is_ss3) = match n {
        1 => (11, true),
        2 => (12, true),
        3 => (13, true),
        4 => (14, true),
        5 => return Some(tilde_with_modifier(15, modifier_bits)),
        6 => return Some(tilde_with_modifier(17, modifier_bits)),
        7 => return Some(tilde_with_modifier(18, modifier_bits)),
        8 => return Some(tilde_with_modifier(19, modifier_bits)),
        9 => return Some(tilde_with_modifier(20, modifier_bits)),
        10 => return Some(tilde_with_modifier(21, modifier_bits)),
        11 => return Some(tilde_with_modifier(23, modifier_bits)),
        12 => return Some(tilde_with_modifier(24, modifier_bits)),
        _ => return None,
    };

    if is_ss3 && modifier_bits == 0 {
        // SS3 form: ESC O P/Q/R/S
        let final_byte = b'P' + (n - 1);
        Some(vec![0x1b, b'O', final_byte])
    } else {
        // CSI form with modifiers: ESC[<num>;<mod>~
        Some(tilde_with_modifier(num, modifier_bits))
    }
}
