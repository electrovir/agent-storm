use std::fs;
use std::path::{Path, PathBuf};

pub struct FolderList {
    base_dir: PathBuf,
    folders: Vec<PathBuf>,
    selected_index: usize,
    hide_bare_repos: bool,
}

impl FolderList {
    pub fn new(base_dir: PathBuf, hide_bare_repos: bool) -> Self {
        let folders = read_subdirs(&base_dir, hide_bare_repos);
        FolderList {
            base_dir,
            folders,
            selected_index: 0,
            hide_bare_repos,
        }
    }

    pub fn folders(&self) -> &[PathBuf] {
        &self.folders
    }

    pub fn selected_index(&self) -> usize {
        self.selected_index
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
