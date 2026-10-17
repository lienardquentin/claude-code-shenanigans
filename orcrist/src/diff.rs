//! The lines a change added, as git tells them.

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
use std::process::Command;

/// Each Rust file the working tree changed since `since`, relative to the current folder, with the lines it added.
/// Files git does not track yet are not in it.
pub fn added_lines(since: &str) -> Result<BTreeMap<PathBuf, BTreeSet<usize>>, String> {
    let output = Command::new("git")
        .args([
            "diff",
            "--unified=0",
            "--no-color",
            "--no-ext-diff",
            "--relative",
            "--end-of-options",
            since,
            "--",
            "*.rs",
        ])
        .output()
        .map_err(|error| format!("cannot run git: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "git diff {since} failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(parse(&String::from_utf8_lossy(&output.stdout)))
}

fn parse(diff: &str) -> BTreeMap<PathBuf, BTreeSet<usize>> {
    let mut added: BTreeMap<PathBuf, BTreeSet<usize>> = BTreeMap::new();
    let mut file = None;
    for line in diff.lines() {
        if let Some(path) = line.strip_prefix("+++ ") {
            file = path.strip_prefix("b/").map(PathBuf::from);
        } else if let (Some(hunk), Some(file)) = (line.strip_prefix("@@ "), &file) {
            // "-12,3 +14,2 @@": the new side starts at 14 and holds 2 lines; a count left out means 1
            let new_side = hunk.split(' ').find_map(|part| part.strip_prefix('+')).unwrap_or("0,0");
            let (start, count) = new_side.split_once(',').unwrap_or((new_side, "1"));
            let (start, count): (usize, usize) = (start.parse().unwrap_or(0), count.parse().unwrap_or(0));
            added.entry(file.clone()).or_default().extend(start..start + count);
        }
    }
    added
}
