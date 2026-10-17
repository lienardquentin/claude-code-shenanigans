//! The lines a change added, as git tells them.

use crate::git::git;
use crate::lang::Language;
use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

/// The lines of a file a change added, None when it added the whole file.
pub type Added = Option<BTreeSet<usize>>;

/// Each file of a language orcrist reads that the working tree changed since `since`, relative to the current folder, with the lines it added. A
/// file git does not track yet is added whole.
pub fn added_lines(since: &str) -> Result<BTreeMap<PathBuf, Added>, String> {
    let diff = git(&[
        &[
            "diff",
            "--unified=0",
            "--no-color",
            "--no-ext-diff",
            "--relative",
            "--end-of-options",
            since,
            "--",
        ],
        &Language::PATHSPECS[..],
    ]
    .concat())?;
    let mut added: BTreeMap<PathBuf, Added> = parse(&diff)
        .into_iter()
        .map(|(file, lines)| (file, Some(lines)))
        .collect();
    let untracked = git(&[
        &["ls-files", "--others", "--exclude-standard", "-z", "--"],
        &Language::PATHSPECS[..],
    ]
    .concat())?;
    added.extend(
        untracked
            .split('\0')
            .filter(|file| !file.is_empty())
            .map(|file| (PathBuf::from(file), None)),
    );
    Ok(added)
}

/// Each file the working tree changed since `since` or does not track yet, relative to the current folder, that is of no
/// language orcrist reads: what `added_lines` leaves out. A deleted file is no longer there to read and is not one.
pub fn unread(since: &str) -> Result<Vec<PathBuf>, String> {
    let changed = git(&[
        "diff",
        "--name-only",
        "--diff-filter=d",
        "-z",
        "--relative",
        "--end-of-options",
        since,
        "--",
    ])?;
    let untracked = git(&["ls-files", "--others", "--exclude-standard", "-z"])?;
    let mut unread: Vec<PathBuf> = changed
        .split('\0')
        .chain(untracked.split('\0'))
        .filter(|file| !file.is_empty())
        .map(PathBuf::from)
        .filter(|file| Language::of(file).is_none())
        .collect();
    unread.sort();
    unread.dedup();
    Ok(unread)
}

fn parse(diff: &str) -> BTreeMap<PathBuf, BTreeSet<usize>> {
    let mut added: BTreeMap<PathBuf, BTreeSet<usize>> = BTreeMap::new();
    let mut file = None;
    for line in diff.lines() {
        if let Some(path) = line.strip_prefix("+++ ") {
            file = unquote(path).strip_prefix("b/").map(PathBuf::from);
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

/// A path as git writes it in a diff: as it is, or in double quotes with C escapes when it holds other than plain
/// ASCII, `"b/\303\251t\303\251.rs"` for `b/été.rs`.
fn unquote(path: &str) -> String {
    let Some(quoted) = path.strip_prefix('"').and_then(|path| path.strip_suffix('"')) else {
        return path.to_string();
    };
    let mut bytes = Vec::new();
    let mut input = quoted.bytes();
    while let Some(byte) = input.next() {
        if byte != b'\\' {
            bytes.push(byte);
            continue;
        }
        match input.next() {
            Some(digit @ b'0'..=b'7') => {
                let octal = [digit, input.next().unwrap_or(b'0'), input.next().unwrap_or(b'0')];
                bytes.push(
                    octal
                        .iter()
                        .fold(0u8, |value, digit| value.wrapping_mul(8) + (digit - b'0')),
                );
            }
            Some(b'n') => bytes.push(b'\n'),
            Some(b't') => bytes.push(b'\t'),
            Some(escaped) => bytes.push(escaped),
            None => {}
        }
    }
    String::from_utf8_lossy(&bytes).into_owned()
}
