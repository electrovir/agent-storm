use bytes::Bytes;
use portable_pty::{CommandBuilder, MasterPty, NativePtySystem, PtySize, PtySystem};
use std::io::{self, Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};
use tokio::sync::mpsc;
use vt100;

/// How long to ignore output after a resize (to avoid the redraw triggering "busy").
const RESIZE_SUPPRESS_DURATION: Duration = Duration::from_secs(2);

pub struct PtyPane {
    parser: Arc<RwLock<vt100::Parser>>,
    input_sender: mpsc::Sender<Bytes>,
    master_pty: Box<dyn MasterPty + Send>,
    exited: Arc<AtomicBool>,
    last_output: Arc<RwLock<Instant>>,
    suppress_until: Arc<RwLock<Instant>>,
}

impl PtyPane {
    pub fn spawn(cmd: CommandBuilder, rows: u16, cols: u16) -> io::Result<Self> {
        let pty_system = NativePtySystem::default();
        let pair = pty_system
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(io::Error::other)?;

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(io::Error::other)?;

        // Drop the slave side — the child process owns it now.
        drop(pair.slave);

        let parser = Arc::new(RwLock::new(vt100::Parser::new(rows, cols, 1000)));
        let exited = Arc::new(AtomicBool::new(false));
        let last_output = Arc::new(RwLock::new(Instant::now()));
        let suppress_until = Arc::new(RwLock::new(Instant::now()));

        // Spawn a thread to wait for the child to exit.
        let exited_clone = exited.clone();
        tokio::task::spawn_blocking(move || {
            let mut child = child;
            let _ = child.wait();
            exited_clone.store(true, Ordering::SeqCst);
        });

        // Reader task: reads PTY output into the vt100 parser.
        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(io::Error::other)?;
        let parser_clone = parser.clone();
        let last_output_clone = last_output.clone();
        let suppress_until_clone = suppress_until.clone();
        tokio::task::spawn_blocking(move || {
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        if let Ok(mut parser) = parser_clone.write() {
                            parser.process(&buf[..n]);
                        }
                        // Only update last_output if not suppressed (e.g. after resize).
                        let suppressed = suppress_until_clone
                            .read()
                            .map(|t| Instant::now() < *t)
                            .unwrap_or(false);
                        if !suppressed
                            && let Ok(mut ts) = last_output_clone.write()
                        {
                            *ts = Instant::now();
                        }
                    }
                    Err(_) => break,
                }
            }
        });

        // Writer task: forwards input bytes to the PTY.
        let mut writer = pair
            .master
            .take_writer()
            .map_err(io::Error::other)?;
        let (input_sender, mut input_receiver) = mpsc::channel::<Bytes>(256);
        tokio::spawn(async move {
            while let Some(data) = input_receiver.recv().await {
                if writer.write_all(&data).is_err() {
                    break;
                }
                let _ = writer.flush();
            }
        });

        Ok(PtyPane {
            parser,
            input_sender,
            master_pty: pair.master,
            exited,
            last_output,
            suppress_until,
        })
    }

    pub fn send_input(&self, data: Bytes) {
        let _ = self.input_sender.try_send(data);
    }

    pub fn screen(&self) -> vt100::Screen {
        self.parser.read().unwrap().screen().clone()
    }

    pub fn resize(&self, rows: u16, cols: u16) {
        // Suppress output tracking so the redraw doesn't trigger "busy".
        if let Ok(mut t) = self.suppress_until.write() {
            *t = Instant::now() + RESIZE_SUPPRESS_DURATION;
        }
        if let Ok(mut parser) = self.parser.write() {
            parser.screen_mut().set_size(rows, cols);
        }
        let _ = self.master_pty.resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        });
    }

    pub fn is_alive(&self) -> bool {
        !self.exited.load(Ordering::SeqCst)
    }

    /// Returns true if the pane produced output within the given threshold.
    pub fn is_busy(&self, threshold_ms: u128) -> bool {
        if !self.is_alive() {
            return false;
        }
        if let Ok(ts) = self.last_output.read() {
            ts.elapsed().as_millis() < threshold_ms
        } else {
            false
        }
    }

    /// Clears the pane's scrollback buffer and screen.
    pub fn clear(&self) {
        if let Ok(mut parser) = self.parser.write() {
            let (rows, cols) = parser.screen().size();
            *parser = vt100::Parser::new(rows, cols, 1000);
        }
    }
}
