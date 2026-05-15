use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RepoConfig {
    pub path: PathBuf,

    /// Command to run in the shell pane after a new worktree is created for this repo.
    #[serde(default)]
    pub post_worktree_cmd: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    /// Command to run in the AI pane.
    #[serde(default = "default_ai_cmd")]
    pub ai_cmd: String,

    /// Default command to run in the shell pane after a new worktree is created.
    /// Per-repo `post_worktree_cmd` overrides this.
    #[serde(default)]
    pub post_worktree_cmd: Option<String>,

    /// Automatically check for and install updates in the background.
    #[serde(default = "default_auto_update")]
    pub auto_update: bool,

    /// List of repos to browse.
    #[serde(default)]
    pub repos: Vec<RepoConfig>,

    /// Folder paths where the AI pane is hidden (shell-only mode).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub hidden_ai_pane: Vec<PathBuf>,

    /// Tmux pane border line style: "heavy", "single", "double", "simple",
    /// or "auto" (default). "auto" uses "heavy" except on VTE-based terminals
    /// (e.g. gnome-terminal) where heavy borders render as double-width.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub border_style: Option<String>,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            ai_cmd: default_ai_cmd(),
            post_worktree_cmd: None,
            auto_update: default_auto_update(),
            repos: Vec::new(),
            hidden_ai_pane: Vec::new(),
            border_style: None,
        }
    }
}

impl Config {
    /// Find a repo config by path.
    pub fn repo_for(&self, path: &PathBuf) -> Option<&RepoConfig> {
        self.repos.iter().find(|r| r.path == *path)
    }

    /// Get the post-worktree command for a repo, falling back to the global default.
    pub fn post_worktree_cmd_for(&self, repo_path: &PathBuf) -> Option<&String> {
        self.repo_for(repo_path)
            .and_then(|r| r.post_worktree_cmd.as_ref())
            .or(self.post_worktree_cmd.as_ref())
    }

    /// Check if a repo path is already in the list.
    pub fn has_repo(&self, path: &PathBuf) -> bool {
        self.repos.iter().any(|r| r.path == *path)
    }

    /// Add a repo.
    pub fn add_repo(&mut self, path: PathBuf, post_worktree_cmd: Option<String>) {
        self.repos.push(RepoConfig {
            path,
            post_worktree_cmd,
        });
    }

    /// Get all repo paths.
    pub fn repo_paths(&self) -> Vec<PathBuf> {
        self.repos.iter().map(|r| r.path.clone()).collect()
    }

    /// Check if the AI pane is hidden for a folder.
    pub fn is_ai_hidden(&self, folder: &Path) -> bool {
        self.hidden_ai_pane.iter().any(|p| p == folder)
    }

    /// Toggle the AI pane hidden state for a folder. Returns the new state.
    pub fn toggle_ai_hidden(&mut self, folder: &Path) -> bool {
        if self.is_ai_hidden(folder) {
            self.hidden_ai_pane.retain(|p| p != folder);
            false
        } else {
            self.hidden_ai_pane.push(folder.to_path_buf());
            true
        }
    }
}

fn default_ai_cmd() -> String {
    "claude".to_string()
}

fn default_auto_update() -> bool {
    true
}

fn config_path() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join(".config").join("agent-storm.toml"))
}

/// Load the config. If the file doesn't exist or is missing fields,
/// write it back with defaults populated (without overwriting existing values).
pub fn load_config() -> Config {
    let Some(path) = config_path() else {
        return Config::default();
    };

    let existing_contents = fs::read_to_string(&path).ok();
    let config: Config = existing_contents
        .as_deref()
        .and_then(|contents| toml::from_str(contents).ok())
        .unwrap_or_default();

    if let Ok(new_contents) = toml::to_string_pretty(&config) {
        let should_write = match &existing_contents {
            None => true,
            Some(existing) => existing.trim() != new_contents.trim(),
        };
        if should_write {
            if let Some(parent) = path.parent() {
                let _ = fs::create_dir_all(parent);
            }
            let _ = fs::write(&path, new_contents);
        }
    }

    config
}

pub fn save_config(config: &Config) -> Result<(), String> {
    let Some(path) = config_path() else {
        return Err("Could not determine config directory.".to_string());
    };

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("Failed to create config directory: {err}"))?;
    }

    let contents =
        toml::to_string_pretty(config).map_err(|err| format!("Failed to serialize config: {err}"))?;

    fs::write(&path, contents).map_err(|err| format!("Failed to write config: {err}"))?;

    Ok(())
}

pub fn config_path_display() -> String {
    config_path()
        .map(|p| p.display().to_string())
        .unwrap_or_else(|| "unknown".to_string())
}
