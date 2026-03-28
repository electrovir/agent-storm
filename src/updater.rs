use std::env;
use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;

const CURRENT_VERSION: &str = env!("CARGO_PKG_VERSION");

fn log_path() -> PathBuf {
    env::temp_dir().join("agent-storm.log")
}

/// Append a timestamped line to the log file.
pub fn log(message: &str) {
    let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path())
    else {
        return;
    };
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let _ = writeln!(file, "[{timestamp}] {message}");
}


/// Fetch the latest release tag from GitHub.
pub fn fetch_latest_tag() -> Result<String, String> {
    let tag_output = Command::new("curl")
        .args([
            "--proto",
            "=https",
            "--tlsv1.2",
            "-sL",
            "https://api.github.com/repos/electrovir/agent-storm/releases/latest",
        ])
        .output()
        .map_err(|err| format!("Failed to run curl: {err}"))?;

    let tag_json = String::from_utf8_lossy(&tag_output.stdout);
    tag_json
        .lines()
        .find(|l| l.contains("\"tag_name\""))
        .and_then(|l| {
            let after_key = &l[l.find("tag_name")? + 8..];
            let colon_rest = &after_key[after_key.find(':')? + 1..];
            let first_quote = &colon_rest[colon_rest.find('"')? + 1..];
            let end = first_quote.find('"')?;
            Some(first_quote[..end].to_string())
        })
        .ok_or_else(|| "Could not determine latest release.".to_string())
}

/// Check if a remote tag represents a newer version than the current binary.
pub fn is_update_available(remote_tag: &str) -> bool {
    let remote = remote_tag.trim_start_matches('v');
    remote != CURRENT_VERSION
}

/// Download and install the update for the given tag.
/// When `allow_sudo` is true, falls back to `sudo cp` for read-only install dirs.
/// When false (background updates), only attempts a regular copy.
pub fn download_and_install(tag: &str, allow_sudo: bool) -> Result<(), String> {
    let target = detect_platform()?;

    let url = format!(
        "https://github.com/electrovir/agent-storm/releases/download/{tag}/agent-storm-{target}.tar.gz"
    );

    let tmp_dir = env::temp_dir().join("ags-update");
    let _ = std::fs::create_dir_all(&tmp_dir);
    let tar_path = tmp_dir.join("agent-storm.tar.gz");

    // Download.
    let dl_status = Command::new("curl")
        .args(["--proto", "=https", "--tlsv1.2", "-sL", &url, "-o"])
        .arg(&tar_path)
        .output()
        .map_err(|err| format!("Download failed: {err}"))?;

    if !dl_status.status.success() {
        let _ = std::fs::remove_dir_all(&tmp_dir);
        return Err("Download failed.".to_string());
    }

    // Extract.
    let extract_status = Command::new("tar")
        .args(["xzf"])
        .arg(&tar_path)
        .arg("-C")
        .arg(&tmp_dir)
        .output()
        .map_err(|err| format!("Extraction failed: {err}"))?;

    if !extract_status.status.success() {
        let _ = std::fs::remove_dir_all(&tmp_dir);
        return Err("Extraction failed.".to_string());
    }

    let new_binary = tmp_dir.join("agent-storm");
    if !new_binary.exists() {
        let _ = std::fs::remove_dir_all(&tmp_dir);
        return Err("Binary not found in archive.".to_string());
    }

    // Install via atomic rename.
    //
    // 1. Copy the new binary to a temp file in the install directory (same filesystem).
    // 2. Set execute permissions and strip macOS quarantine on the temp file.
    // 3. Atomically rename the temp file to the final path.
    //
    // rename() on the same filesystem is atomic: it swaps the directory entry instantly.
    // The old inode stays alive for any running processes. New invocations get the new binary.
    // This avoids corrupting/killing a running instance (which fs::copy would do).
    let install_path =
        env::current_exe().map_err(|err| format!("Cannot find current exe: {err}"))?;
    let install_dir = install_path
        .parent()
        .unwrap_or(Path::new("/usr/local/bin"));
    let dest = install_dir.join("agent-storm");
    let staging = install_dir.join(".agent-storm.next");

    // Try direct copy first.
    let direct_err = match install_direct(&new_binary, &staging, &dest, install_dir) {
        Ok(()) => {
            let _ = std::fs::remove_dir_all(&tmp_dir);
            return Ok(());
        }
        Err(err) => err,
    };

    // Fall back to sudo if allowed (interactive `--update` mode).
    if allow_sudo {
        install_with_sudo(&new_binary, &staging, &dest, &tmp_dir)?;
        let _ = std::fs::remove_dir_all(&tmp_dir);
        return Ok(());
    }

    let _ = std::fs::remove_dir_all(&tmp_dir);
    Err(direct_err)
}

/// Check for an update and install it if available. Returns the new tag on success.
pub fn check_and_apply_update(allow_sudo: bool) -> Result<String, String> {
    let tag = fetch_latest_tag()?;
    if !is_update_available(&tag) {
        return Err("Already up to date.".to_string());
    }
    download_and_install(&tag, allow_sudo)?;
    Ok(tag)
}

fn install_direct(
    new_binary: &Path,
    staging: &Path,
    dest: &Path,
    install_dir: &Path,
) -> Result<(), String> {
    std::fs::copy(new_binary, staging)
        .map_err(|err| format!("Failed to copy binary: {err}"))?;
    std::fs::set_permissions(staging, std::fs::Permissions::from_mode(0o755))
        .map_err(|err| format!("Failed to set permissions: {err}"))?;
    if cfg!(target_os = "macos") {
        let _ = Command::new("xattr")
            .args(["-d", "com.apple.quarantine"])
            .arg(staging)
            .output();
    }
    std::fs::rename(staging, dest).map_err(|err| {
        let _ = std::fs::remove_file(staging);
        format!("Failed to rename binary: {err}")
    })?;
    let ags_link = install_dir.join("ags");
    if !ags_link.exists() {
        let _ = std::os::unix::fs::symlink(dest, &ags_link);
    }
    Ok(())
}

fn install_with_sudo(
    new_binary: &Path,
    staging: &Path,
    dest: &Path,
    tmp_dir: &Path,
) -> Result<(), String> {
    let ok = Command::new("sudo")
        .args(["cp"])
        .arg(new_binary)
        .arg(staging)
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    if !ok {
        let _ = std::fs::remove_dir_all(tmp_dir);
        return Err("sudo cp failed.".to_string());
    }
    let _ = Command::new("sudo")
        .args(["chmod", "+x"])
        .arg(staging)
        .status();
    if cfg!(target_os = "macos") {
        let _ = Command::new("sudo")
            .args(["xattr", "-d", "com.apple.quarantine"])
            .arg(staging)
            .output();
    }
    let ok = Command::new("sudo")
        .args(["mv"])
        .arg(staging)
        .arg(dest)
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    if !ok {
        let _ = Command::new("sudo")
            .args(["rm", "-f"])
            .arg(staging)
            .status();
        let _ = std::fs::remove_dir_all(tmp_dir);
        return Err("sudo mv failed.".to_string());
    }
    Ok(())
}

fn detect_platform() -> Result<&'static str, String> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => Ok("aarch64-apple-darwin"),
        ("macos", "x86_64") => Ok("x86_64-apple-darwin"),
        ("linux", "aarch64") => Ok("aarch64-unknown-linux-gnu"),
        ("linux", "x86_64") => Ok("x86_64-unknown-linux-gnu"),
        (os, arch) => Err(format!("Unsupported platform: {os}/{arch}")),
    }
}
