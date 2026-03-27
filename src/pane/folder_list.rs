use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum GitStatus {
    Clean,
    Dirty,
    Unpushed,
}

pub struct FolderList {
    base_dir: PathBuf,
    folders: Vec<PathBuf>,
    selected_index: usize,
    hide_bare_repos: bool,
    git_status: HashMap<PathBuf, GitStatus>,
    last_dirty_check: std::time::Instant,
    dirty_check_in_flight: Arc<AtomicBool>,
}

impl FolderList {
    pub fn new(base_dir: PathBuf, hide_bare_repos: bool) -> Self {
        let folders = read_subdirs(&base_dir, hide_bare_repos);
        FolderList {
            base_dir,
            folders,
            selected_index: 0,
            hide_bare_repos,
            git_status: HashMap::new(),
            last_dirty_check: std::time::Instant::now(),
            dirty_check_in_flight: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn folders(&self) -> &[PathBuf] {
        &self.folders
    }

    pub fn selected_index(&self) -> usize {
        self.selected_index
    }

    pub fn git_status(&self, folder: &Path) -> GitStatus {
        self.git_status
            .get(folder)
            .copied()
            .unwrap_or(GitStatus::Clean)
    }

    /// Applies git status results from a background task.
    pub fn apply_git_status(&mut self, status: HashMap<PathBuf, GitStatus>) {
        self.git_status = status;
        self.dirty_check_in_flight.store(false, Ordering::SeqCst);
    }

    /// Spawns a background dirty check if enough time has passed and one isn't already running.
    /// Returns the folders to check, or None if no check is needed.
    pub fn maybe_start_dirty_check(&mut self) -> Option<(Vec<PathBuf>, Arc<AtomicBool>)> {
        if self.last_dirty_check.elapsed() < std::time::Duration::from_secs(2) {
            return None;
        }
        if self.dirty_check_in_flight.load(Ordering::SeqCst) {
            return None;
        }
        self.last_dirty_check = std::time::Instant::now();
        self.dirty_check_in_flight.store(true, Ordering::SeqCst);
        Some((self.folders.clone(), self.dirty_check_in_flight.clone()))
    }

    pub fn selected_folder(&self) -> Option<&Path> {
        self.folders.get(self.selected_index).map(|p| p.as_path())
    }

    pub fn move_up(&mut self) {
        if !self.folders.is_empty() {
            if self.selected_index == 0 {
                self.selected_index = self.folders.len() - 1;
            } else {
                self.selected_index -= 1;
            }
        }
    }

    pub fn move_down(&mut self) {
        if !self.folders.is_empty() {
            self.selected_index = (self.selected_index + 1) % self.folders.len();
        }
    }

    pub fn refresh(&mut self) {
        let previously_selected = self.selected_folder().map(|p| p.to_path_buf());
        self.folders = read_subdirs(&self.base_dir, self.hide_bare_repos);

        if let Some(prev) = previously_selected
            && let Some(idx) = self.folders.iter().position(|f| *f == prev)
        {
            self.selected_index = idx;
            return;
        }
        self.selected_index = self.selected_index.min(self.folders.len().saturating_sub(1));
    }
}

fn read_subdirs(base: &Path, hide_bare_repos: bool) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(base) else {
        return Vec::new();
    };

    let mut dirs: Vec<PathBuf> = entries
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let path = entry.path();
            if path.is_dir() {
                let name = path.file_name()?.to_str()?;
                if name.starts_with('.') {
                    return None;
                }
                if hide_bare_repos && is_bare_git_repo(&path) {
                    return None;
                }
                return Some(path);
            }
            None
        })
        .collect();

    dirs.sort();
    dirs
}

/// A bare git repo has HEAD, refs/, and objects/ directly inside it
/// (no .git subdirectory).
fn is_bare_git_repo(path: &Path) -> bool {
    path.join("HEAD").is_file() && path.join("refs").is_dir() && path.join("objects").is_dir()
}

fn get_git_status(path: &Path) -> GitStatus {
    // Check for uncommitted changes first.
    let dirty = Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(path)
        .output()
        .map(|output| output.status.success() && !output.stdout.is_empty())
        .unwrap_or(false);

    if dirty {
        return GitStatus::Dirty;
    }

    // Check for unpushed commits (local ahead of remote).
    let unpushed = Command::new("git")
        .args(["log", "--oneline", "@{upstream}..HEAD"])
        .current_dir(path)
        .output()
        .map(|output| output.status.success() && !output.stdout.is_empty())
        .unwrap_or(false);

    if unpushed {
        return GitStatus::Unpushed;
    }

    GitStatus::Clean
}

pub fn check_git_status_all(folders: &[PathBuf]) -> HashMap<PathBuf, GitStatus> {
    folders
        .iter()
        .map(|f| (f.clone(), get_git_status(f)))
        .collect()
}
