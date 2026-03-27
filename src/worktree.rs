use std::path::Path;
use std::process::Command;

/// Checks if a directory appears to be a parent folder of git worktrees.
/// This is true if many/all of its subdirectories are git worktrees pointing
/// to the same bare repo or common `.git` directory.
pub fn is_worktree_root(base_dir: &Path) -> bool {
    // A common pattern: the base_dir itself is a bare repo, or it contains
    // subdirectories that are git worktrees. We detect by checking if any
    // subdirectory has a `.git` file (not directory) pointing to a worktree path.
    let Ok(entries) = std::fs::read_dir(base_dir) else {
        return false;
    };

    let mut worktree_count = 0u32;
    let mut dir_count = 0u32;

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
        dir_count += 1;

        let dot_git = path.join(".git");
        // A worktree has a `.git` _file_ (not directory) containing "gitdir: ..."
        if dot_git.is_file() {
            worktree_count += 1;
        }
        // A regular clone has a `.git` directory — also count it if it's part
        // of a worktree setup (the main worktree).
        else if dot_git.is_dir() {
            // Check if this repo has worktrees configured.
            let worktrees_dir = dot_git.join("worktrees");
            if worktrees_dir.is_dir() {
                worktree_count += 1;
            }
        }
    }

    // Consider it a worktree root if at least 2 subdirectories are worktrees,
    // or if there's only 1 directory and it is a worktree.
    dir_count > 0 && worktree_count > 0 && (worktree_count >= 2 || dir_count == 1)
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
    let target_str = target
        .to_str()
        .ok_or_else(|| "Invalid path.".to_string())?;

    let output = Command::new("git")
        .args(["worktree", "remove", target_str, "--force"])
        .current_dir(any_worktree)
        .output()
        .map_err(|err| format!("Failed to run git: {err}"))?;

    if output.status.success() {
        let name = target
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("unknown");
        Ok(format!("Worktree '{name}' removed."))
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("git worktree remove failed: {stderr}"))
    }
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
