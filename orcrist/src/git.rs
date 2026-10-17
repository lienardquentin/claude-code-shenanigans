//! git, run as orcrist asks it things.

use std::process::Command;

/// What git writes to stdout, or what went wrong when it fails.
pub fn git(args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .args(args)
        .output()
        .map_err(|error| format!("cannot run git: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "git {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Whether the current folder is in a git repository's working tree.
pub fn inside_repository() -> bool {
    git(&["rev-parse", "--is-inside-work-tree"]).is_ok()
}
