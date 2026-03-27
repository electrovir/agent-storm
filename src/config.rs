use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    /// Command to run in the AI pane.
    #[serde(default = "default_ai_cmd")]
    pub ai_cmd: String,

    /// Command to run in the shell pane after a new worktree is created.
    #[serde(default)]
    pub post_worktree_cmd: Option<String>,

    /// Whether to disable mouse capture on startup.
    #[serde(default)]
    pub no_mouse: bool,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            ai_cmd: default_ai_cmd(),
            post_worktree_cmd: None,
            no_mouse: false,
        }
    }
}

fn default_ai_cmd() -> String {
    "claude".to_string()
}

fn config_path() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join(".config").join("agent-storm.toml"))
}

pub fn load_config() -> Config {
    let Some(path) = config_path() else {
        return Config::default();
    };

    let Ok(contents) = fs::read_to_string(&path) else {
        return Config::default();
    };

    toml::from_str(&contents).unwrap_or_default()
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
