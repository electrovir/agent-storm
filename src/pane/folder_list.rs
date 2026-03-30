use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use crate::worktree;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum GitStatus {
    Clean,
    Dirty,
    Unpushed,
}

/// PR info for a folder's current branch.
#[derive(Clone, Debug)]
pub struct PrInfo {
    pub url: String,
    pub merged: bool,
}

/// A single line in the sidebar display.
#[derive(Clone)]
pub enum SidebarEntry {
    /// A repo header (shown when the repo has worktrees). Not selectable.
    RepoHeader {
        path: PathBuf,
        name: String,
    },
    /// A selectable item (worktree under a repo, or a standalone repo).
    Item {
        path: PathBuf,
        name: String,
        indented: bool,
        is_worktree_child: bool,
    },
}

impl SidebarEntry {
    pub fn path(&self) -> &Path {
        match self {
            SidebarEntry::RepoHeader { path, .. } => path,
            SidebarEntry::Item { path, .. } => path,
        }
    }

    pub fn is_selectable(&self) -> bool {
        matches!(self, SidebarEntry::Item { .. })
    }
}

const PR_CHECK_INTERVAL_SECS: u64 = 60;

pub struct FolderList {
    entries: Vec<SidebarEntry>,
    /// Indices into `entries` of selectable items only.
    selectable_indices: Vec<usize>,
    selected: usize,
    git_status: HashMap<PathBuf, GitStatus>,
    last_dirty_check: std::time::Instant,
    dirty_check_in_flight: Arc<AtomicBool>,
    pr_info: HashMap<PathBuf, PrInfo>,
    last_pr_check: std::time::Instant,
    pr_check_in_flight: Arc<AtomicBool>,
    pr_consecutive_failures: u32,
    repos: Vec<PathBuf>,
    /// Paths to hide from the sidebar (e.g. worktrees being deleted in the background).
    hidden_paths: HashSet<PathBuf>,
}

impl FolderList {
    pub fn new(repos: Vec<PathBuf>) -> Self {
        let hidden_paths = HashSet::new();
        let (entries, selectable_indices) = build_entries(&repos, &hidden_paths);
        FolderList {
            entries,
            selectable_indices,
            selected: 0,
            git_status: HashMap::new(),
            last_dirty_check: std::time::Instant::now(),
            dirty_check_in_flight: Arc::new(AtomicBool::new(false)),
            pr_info: HashMap::new(),
            last_pr_check: std::time::Instant::now()
                .checked_sub(std::time::Duration::from_secs(PR_CHECK_INTERVAL_SECS))
                .unwrap_or_else(std::time::Instant::now),
            pr_check_in_flight: Arc::new(AtomicBool::new(false)),
            pr_consecutive_failures: 0,
            repos,
            hidden_paths,
        }
    }

    pub fn entries(&self) -> &[SidebarEntry] {
        &self.entries
    }

    /// Returns the entry index in `entries()` for the currently selected item.
    pub fn selected_entry_index(&self) -> Option<usize> {
        self.selectable_indices.get(self.selected).copied()
    }

    /// Returns the currently selected folder path.
    pub fn selected_folder(&self) -> Option<&Path> {
        self.selected_entry_index()
            .and_then(|i| self.entries.get(i))
            .map(|e| e.path())
    }

    /// Returns whether the selected item is a worktree child (for worktree-specific operations).
    pub fn selected_is_worktree(&self) -> bool {
        self.selected_entry_index()
            .and_then(|i| self.entries.get(i))
            .map(|e| matches!(e, SidebarEntry::Item { is_worktree_child: true, .. }))
            .unwrap_or(false)
    }

    /// Returns the parent repo path for the currently selected item.
    /// For worktree children, this is the repo header's path.
    /// For standalone repos, this is the item's own path.
    pub fn selected_repo_path(&self) -> Option<PathBuf> {
        let sel_idx = self.selected_entry_index()?;
        let entry = self.entries.get(sel_idx)?;

        match entry {
            SidebarEntry::Item { is_worktree_child: false, path, .. } => {
                Some(path.clone())
            }
            SidebarEntry::Item { is_worktree_child: true, .. } => {
                // Walk backwards to find the parent repo header.
                let mut idx = sel_idx;
                while idx > 0 {
                    idx -= 1;
                    if let SidebarEntry::RepoHeader { path, .. } = &self.entries[idx] {
                        return Some(path.clone());
                    }
                }
                None
            }
            SidebarEntry::RepoHeader { path, .. } => Some(path.clone()),
        }
    }

    /// Count how many selectable worktree siblings exist for the selected item's parent repo.
    pub fn selected_sibling_count(&self) -> usize {
        let Some(sel_idx) = self.selected_entry_index() else {
            return 0;
        };
        // Walk backwards to find the parent repo header.
        let mut parent_idx = sel_idx;
        while parent_idx > 0 {
            parent_idx -= 1;
            if matches!(self.entries[parent_idx], SidebarEntry::RepoHeader { .. }) {
                break;
            }
        }
        // Count all selectable items after the header until the next header or end.
        let mut count = 0;
        for entry in &self.entries[parent_idx + 1..] {
            if matches!(entry, SidebarEntry::RepoHeader { .. }) {
                break;
            }
            if entry.is_selectable() {
                count += 1;
            }
        }
        count
    }

    pub fn git_status(&self, folder: &Path) -> GitStatus {
        self.git_status
            .get(folder)
            .copied()
            .unwrap_or(GitStatus::Clean)
    }

    pub fn apply_git_status(&mut self, status: HashMap<PathBuf, GitStatus>) {
        self.git_status = status;
        self.dirty_check_in_flight.store(false, Ordering::SeqCst);
    }

    pub fn maybe_start_dirty_check(&mut self) -> Option<(Vec<PathBuf>, Arc<AtomicBool>)> {
        if self.last_dirty_check.elapsed() < std::time::Duration::from_secs(2) {
            return None;
        }
        if self.dirty_check_in_flight.load(Ordering::SeqCst) {
            return None;
        }
        self.last_dirty_check = std::time::Instant::now();
        self.dirty_check_in_flight.store(true, Ordering::SeqCst);
        let folders: Vec<PathBuf> = self
            .entries
            .iter()
            .filter(|e| e.is_selectable())
            .map(|e| e.path().to_path_buf())
            .collect();
        Some((folders, self.dirty_check_in_flight.clone()))
    }

    pub fn pr_info(&self, folder: &Path) -> Option<&PrInfo> {
        self.pr_info.get(folder)
    }

    pub fn apply_pr_status(&mut self, info: HashMap<PathBuf, PrInfo>, had_errors: bool) {
        self.pr_info = info;
        self.pr_check_in_flight.store(false, Ordering::SeqCst);
        if had_errors {
            self.pr_consecutive_failures = self.pr_consecutive_failures.saturating_add(1);
        } else {
            self.pr_consecutive_failures = 0;
        }
    }

    pub fn maybe_start_pr_check(&mut self) -> Option<(Vec<PathBuf>, Arc<AtomicBool>)> {
        // Back off exponentially on consecutive failures: 60s, 120s, 240s, ... up to ~16min.
        let backoff_multiplier = 1u64 << self.pr_consecutive_failures.min(4);
        let interval = std::time::Duration::from_secs(PR_CHECK_INTERVAL_SECS * backoff_multiplier);
        if self.last_pr_check.elapsed() < interval {
            return None;
        }
        if self.pr_check_in_flight.load(Ordering::SeqCst) {
            return None;
        }
        self.last_pr_check = std::time::Instant::now();
        self.pr_check_in_flight.store(true, Ordering::SeqCst);
        let folders: Vec<PathBuf> = self
            .entries
            .iter()
            .filter(|e| e.is_selectable())
            .map(|e| e.path().to_path_buf())
            .collect();
        Some((folders, self.pr_check_in_flight.clone()))
    }

    pub fn move_up(&mut self) {
        if !self.selectable_indices.is_empty() {
            if self.selected == 0 {
                self.selected = self.selectable_indices.len() - 1;
            } else {
                self.selected -= 1;
            }
        }
    }

    pub fn move_down(&mut self) {
        if !self.selectable_indices.is_empty() {
            self.selected = (self.selected + 1) % self.selectable_indices.len();
        }
    }

    /// Hide a path from the sidebar until `clear_hidden` is called.
    pub fn hide_path(&mut self, path: PathBuf) {
        self.hidden_paths.insert(path);
    }

    /// Clear all hidden paths (call after background deletion completes).
    pub fn clear_hidden(&mut self) {
        self.hidden_paths.clear();
    }

    pub fn refresh(&mut self) {
        let previously_selected = self.selected_folder().map(|p| p.to_path_buf());
        let (entries, selectable_indices) = build_entries(&self.repos, &self.hidden_paths);
        self.entries = entries;
        self.selectable_indices = selectable_indices;

        if let Some(prev) = previously_selected
            && let Some(idx) = self
                .selectable_indices
                .iter()
                .position(|&i| self.entries[i].path() == prev)
        {
            self.selected = idx;
            return;
        }
        self.selected = self
            .selected
            .min(self.selectable_indices.len().saturating_sub(1));
    }

    /// Select the entry at a given display row, accounting for line wrapping.
    pub fn select_at_row(&mut self, row: u16, width: u16) {
        let width = width as usize;
        let mut current_row: usize = 0;

        for (idx, entry) in self.entries.iter().enumerate() {
            let (prefix_width, name_len) = match entry {
                SidebarEntry::RepoHeader { name, .. } => (2, name.len()),
                SidebarEntry::Item {
                    name,
                    indented,
                    path,
                    ..
                } => {
                    let pw = if *indented { 4 } else { 2 };
                    let suffix_len = match self.git_status(path) {
                        GitStatus::Dirty | GitStatus::Unpushed => 1,
                        GitStatus::Clean => 0,
                    };
                    (pw, name.len() + suffix_len)
                }
            };

            let line_count = entry_line_count(prefix_width, name_len, width);
            let entry_end = current_row + line_count;

            if (row as usize) < entry_end {
                // Click is within this entry.
                if entry.is_selectable()
                    && let Some(sel_idx) = self
                        .selectable_indices
                        .iter()
                        .position(|&i| i == idx)
                {
                    self.selected = sel_idx;
                }
                return;
            }
            current_row = entry_end;
        }
    }
}

fn entry_line_count(prefix_width: usize, name_len: usize, area_width: usize) -> usize {
    let first_avail = area_width.saturating_sub(prefix_width);
    if name_len <= first_avail {
        return 1;
    }
    let cont_indent = prefix_width + 2;
    let cont_avail = area_width.saturating_sub(cont_indent).max(1);
    let remaining = name_len - first_avail;
    1 + remaining.div_ceil(cont_avail)
}

fn build_entries(repos: &[PathBuf], hidden: &HashSet<PathBuf>) -> (Vec<SidebarEntry>, Vec<usize>) {
    let mut entries = Vec::new();
    let mut selectable = Vec::new();

    // Partition repos into plain (no worktrees) and worktree roots, sorted alphabetically.
    let mut plain_repos: Vec<&PathBuf> = Vec::new();
    let mut wt_repos: Vec<&PathBuf> = Vec::new();
    for repo_path in repos {
        if worktree::is_worktree_root(repo_path) {
            wt_repos.push(repo_path);
        } else {
            plain_repos.push(repo_path);
        }
    }
    let repo_name = |p: &&PathBuf| {
        p.file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("?")
            .to_lowercase()
    };
    plain_repos.sort_by_key(|a| repo_name(a));
    wt_repos.sort_by_key(|a| repo_name(a));

    // Plain repos first.
    for repo_path in &plain_repos {
        let canonical = std::fs::canonicalize(repo_path)
            .unwrap_or_else(|_| (*repo_path).clone());
        if hidden.contains(&canonical) {
            continue;
        }
        let name = repo_path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("?")
            .to_string();
        selectable.push(entries.len());
        entries.push(SidebarEntry::Item {
            path: canonical,
            name,
            indented: false,
            is_worktree_child: false,
        });
    }

    // Worktree repos after.
    for repo_path in &wt_repos {
        let name = repo_path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("?")
            .to_string();
        entries.push(SidebarEntry::RepoHeader {
            path: (*repo_path).clone(),
            name,
        });

        let mut worktrees = read_subdirs(repo_path, true);
        worktrees.sort();
        for wt in worktrees {
            let wt = std::fs::canonicalize(&wt).unwrap_or(wt);
            if hidden.contains(&wt) {
                continue;
            }
            let wt_name = wt
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("?")
                .to_string();
            selectable.push(entries.len());
            entries.push(SidebarEntry::Item {
                path: wt,
                name: wt_name,
                indented: true,
                is_worktree_child: true,
            });
        }
    }

    (entries, selectable)
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

fn is_bare_git_repo(path: &Path) -> bool {
    path.join("HEAD").is_file() && path.join("refs").is_dir() && path.join("objects").is_dir()
}

fn get_git_status(path: &Path) -> GitStatus {
    let dirty = Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(path)
        .output()
        .map(|output| output.status.success() && !output.stdout.is_empty())
        .unwrap_or(false);

    if dirty {
        return GitStatus::Dirty;
    }

    // Check if the branch has an upstream at all.
    let has_upstream = Command::new("git")
        .args(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"])
        .current_dir(path)
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false);

    if !has_upstream {
        // Branch has never been pushed — no remote to be ahead of.
        return GitStatus::Clean;
    }

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

/// Check if `gh` CLI is available and authenticated.
fn is_gh_available() -> bool {
    Command::new("gh")
        .args(["auth", "status"])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

fn get_branch_name(path: &Path) -> Option<String> {
    Command::new("git")
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(path)
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty() && s != "HEAD")
}

fn get_pr_info(path: &Path) -> Result<Option<PrInfo>, String> {
    let Some(branch) = get_branch_name(path) else {
        return Ok(None);
    };
    let output = Command::new("gh")
        .args(["pr", "view", &branch, "--json", "url,state"])
        .current_dir(path)
        .output()
        .map_err(|err| format!("gh pr view failed for {}: {err}", path.display()))?;

    if !output.status.success() {
        // gh pr view exits non-zero when there is no PR for the branch.
        return Ok(None);
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    // Parse minimal JSON: {"url":"https://...","state":"OPEN|MERGED|CLOSED"}
    let url = stdout.find("\"url\"").and_then(|i| {
        let rest = &stdout[i + 5..];
        let colon_rest = &rest[rest.find(':')? + 1..];
        let first_quote = &colon_rest[colon_rest.find('"')? + 1..];
        let end = first_quote.find('"')?;
        Some(first_quote[..end].to_string())
    });
    let state = stdout.find("\"state\"").map(|i| {
        let rest = &stdout[i..];
        if rest.contains("MERGED") {
            "MERGED"
        } else if rest.contains("CLOSED") {
            "CLOSED"
        } else {
            "OPEN"
        }
    });

    // Closed (not merged) PRs are effectively gone — don't show them.
    if state == Some("CLOSED") {
        return Ok(None);
    }

    let merged = state == Some("MERGED");
    Ok(url.map(|url| PrInfo { url, merged }))
}

/// Check all folders for open PRs. Returns results and whether any errors occurred.
pub fn check_pr_status_all(folders: &[PathBuf]) -> (HashMap<PathBuf, PrInfo>, bool) {
    if !is_gh_available() {
        return (HashMap::new(), false);
    }
    let mut results = HashMap::new();
    let mut had_errors = false;
    for folder in folders {
        match get_pr_info(folder) {
            Ok(Some(info)) => {
                results.insert(folder.clone(), info);
            }
            Ok(None) => {}
            Err(err) => {
                crate::updater::log(&err);
                had_errors = true;
            }
        }
    }
    (results, had_errors)
}
