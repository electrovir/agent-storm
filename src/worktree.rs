use std::path::Path;
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

/// Checks if a specific directory is a git worktree (has a `.git` file, not directory).
pub fn is_worktree(path: &Path) -> bool {
    let dot_git = path.join(".git");
    dot_git.is_file()
}

/// Renames a folder. If it's a git worktree, uses `git worktree move`.
/// Otherwise, uses a plain filesystem rename.
pub fn rename_folder(folder: &Path, new_name: &str) -> Result<(String, std::path::PathBuf), String> {
    let parent = folder
        .parent()
        .ok_or_else(|| "Cannot determine parent directory.".to_string())?;
    let new_path = parent.join(new_name);

    if new_path.exists() {
        return Err(format!("'{new_name}' already exists."));
    }

    if is_worktree(folder) {
        // Use git worktree move for proper reference updates.
        let output = Command::new("git")
            .args([
                "worktree",
                "move",
                folder.to_str().ok_or("Invalid path.")?,
                new_path.to_str().ok_or("Invalid path.")?,
            ])
            .current_dir(folder)
            .output()
            .map_err(|err| format!("Failed to run git: {err}"))?;

        if output.status.success() {
            let old_name = folder
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("?");
            Ok((
                format!("Worktree renamed: {old_name} -> {new_name}"),
                new_path,
            ))
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr);
            Err(format!("git worktree move failed: {stderr}"))
        }
    } else {
        // Plain filesystem rename.
        std::fs::rename(folder, &new_path)
            .map_err(|err| format!("Rename failed: {err}"))?;
        let old_name = folder
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("?");
        Ok((
            format!("Renamed: {old_name} -> {new_name}"),
            new_path,
        ))
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
