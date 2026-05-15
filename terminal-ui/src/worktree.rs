use std::path::{Path, PathBuf};
use std::process::Command;

/// Checks if a directory appears to be a parent folder of git worktrees.
/// This is true if many/all of its subdirectories are git worktrees pointing
/// to the same bare repo or common `.git` directory.
pub fn is_worktree_root(base_dir: &Path) -> bool {
    let Ok(entries) = std::fs::read_dir(base_dir) else {
        return false;
    };

    let mut worktree_count = 0u32;

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let name = match path.file_name().and_then(|n| n.to_str()) {
            Some(n) => n,
            None => continue,
        };
        if name.starts_with('.') {
            continue;
        }

        let dot_git = path.join(".git");
        // A worktree has a `.git` _file_ (not directory) containing "gitdir: ..."
        if dot_git.is_file() {
            worktree_count += 1;
        }
        // A regular clone has a `.git` directory — also count it if it's part
        // of a worktree setup (the main worktree).
        else if dot_git.is_dir() {
            let worktrees_dir = dot_git.join("worktrees");
            if worktrees_dir.is_dir() {
                worktree_count += 1;
            }
        }
    }

    worktree_count > 0
}

/// Adds a new git worktree by running:
///   cd <existing_worktree> && git worktree add ../<branch_name>
///
/// `existing_worktree` is any existing worktree directory (used to find the repo).
/// `branch_name` is used as both the new directory name and branch name.
/// Removes a git worktree by running:
///   git worktree remove <path> --force
///
/// `any_worktree` is any sibling worktree (used to find the repo).
/// `target` is the worktree directory to remove.
pub fn remove_worktree(any_worktree: &Path, target: &Path) -> Result<String, String> {
    let repo_root = any_worktree
        .parent()
        .ok_or_else(|| "Cannot determine repo root.".to_string())?;

    // Safety: only allow deleting paths that are direct children of the repo root.
    if target.parent() != Some(repo_root) {
        return Err(format!(
            "Refusing to delete: target is not inside repo root '{}'.",
            repo_root.display()
        ));
    }

    let target_str = target
        .to_str()
        .ok_or_else(|| "Invalid path.".to_string())?;

    let output = Command::new("git")
        .args(["worktree", "remove", target_str, "--force"])
        .current_dir(any_worktree)
        .output()
        .map_err(|err| format!("Failed to run git: {err}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git worktree remove failed: {stderr}"));
    }

    // git worktree remove doesn't always clean up the directory on disk.
    if target.exists() {
        std::fs::remove_dir_all(target)
            .map_err(|err| format!("Worktree removed from git but failed to delete folder: {err}"))?;
    }

    let name = target
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("unknown");
    Ok(format!("Worktree '{name}' removed."))
}

pub fn add_worktree(existing_worktree: &Path, branch_name: &str) -> Result<String, String> {
    let new_path = existing_worktree
        .parent()
        .ok_or_else(|| "Cannot determine parent directory.".to_string())?
        .join(branch_name);

    let output = Command::new("git")
        .args(["worktree", "add", &format!("../{branch_name}")])
        .current_dir(existing_worktree)
        .output()
        .map_err(|err| format!("Failed to run git: {err}"))?;

    if output.status.success() {
        Ok(format!(
            "Worktree created at {}",
            new_path.display()
        ))
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("git worktree add failed: {stderr}"))
    }
}

/// Given a path, find the best directory to add to repos:
/// 1. Find the git repo root.
/// 2. If the repo root is a worktree, use the worktree's parent folder.
/// 3. If it's a normal repo, use the repo root.
/// 4. If no git repo is found, use the path as-is.
pub fn resolve_repo_path(path: &Path) -> PathBuf {
    let git_root = Command::new("git")
        .args(["rev-parse", "--show-toplevel"])
        .current_dir(path)
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| PathBuf::from(s.trim()));

    let Some(root) = git_root else {
        return path.to_path_buf();
    };

    // If the repo root is a worktree (.git is a file), use its parent.
    let dot_git = root.join(".git");
    if dot_git.is_file()
        && let Some(parent) = root.parent()
    {
        return parent.to_path_buf();
    }

    root
}
