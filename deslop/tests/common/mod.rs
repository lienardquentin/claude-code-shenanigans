//! What the test files share: a folder of a test's own, the binary run in it, and git.
#![allow(dead_code, reason = "each test file uses some of these")]

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

/// A folder of the test's own, holding the sources deslop is pointed at.
pub fn folder(test: &str) -> PathBuf {
    let folder = std::env::temp_dir().join(format!("deslop-{}-{test}", std::process::id()));
    fs::remove_dir_all(&folder).ok(); // deslop: spare swallowed-error: the first run has no folder to remove
    fs::create_dir_all(&folder).unwrap();
    folder
}

pub fn run(folder: &Path, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_deslop"))
        .args(args)
        .current_dir(folder)
        .output()
        .unwrap()
}

// deslop: spare duplicate-helper: narsil's tests are another crate, which these cannot share a helper with
pub fn stdout(output: &Output) -> String {
    String::from_utf8(output.stdout.clone()).unwrap()
}

/// deslop run on one file of the given name and source, in a folder of the test's own.
pub fn check(test: &str, name: &str, source: &str) -> Output {
    let folder = folder(test);
    fs::write(folder.join(name), source).unwrap();
    run(&folder, &["check", name])
}

pub fn git(folder: &Path, args: &[&str]) {
    let status = Command::new("git")
        .args(["-c", "user.name=deslop", "-c", "user.email=deslop@example.com"])
        .args(args)
        .current_dir(folder)
        .status()
        .unwrap();
    assert!(status.success(), "git {args:?} failed");
}

/// Writes each file, its folders made first.
pub fn write(folder: &Path, files: &[(&str, &str)]) {
    for (name, text) in files {
        let path = folder.join(name);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }
}

pub const SLUG_OF: &str = "export function slugOf(name: string): string {\n  const lowered = name.trim().toLowerCase()\n  const joined = lowered.split(' ').join('-')\n  return joined.replace(/[^a-z-]/g, '')\n}\n";
