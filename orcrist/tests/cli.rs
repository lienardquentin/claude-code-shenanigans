//! orcrist run as a person runs it: the binary, its arguments, and what it wrote and exited with.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

/// A folder of the test's own, holding the sources orcrist is pointed at.
fn folder(test: &str) -> PathBuf {
    let folder = std::env::temp_dir().join(format!("orcrist-{}-{test}", std::process::id()));
    fs::remove_dir_all(&folder).ok(); // orcrist: spare swallowed-error: the first run has no folder to remove
    fs::create_dir_all(&folder).unwrap();
    folder
}

fn run(folder: &Path, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_orcrist"))
        .args(args)
        .current_dir(folder)
        .output()
        .unwrap()
}

fn stdout(output: &Output) -> String {
    String::from_utf8(output.stdout.clone()).unwrap()
}

#[test]
fn a_comment_that_restates_its_line_is_found() {
    let folder = folder("restating");
    fs::write(
        folder.join("load.rs"),
        "fn load(path: &str) -> Config {\n    // read the config file\n    let config = read_config_file(path);\n    config\n}\n",
    )
    .unwrap();

    let output = run(&folder, &["check", "load.rs"]);

    assert_eq!(
        stdout(&output),
        "load.rs:2 restating-comment: the comment says what line 3 already says\n"
    );
    assert_eq!(output.status.code(), Some(1));
}

fn git(folder: &Path, args: &[&str]) {
    let status = Command::new("git")
        .args(["-c", "user.name=orcrist", "-c", "user.email=orcrist@example.com"])
        .args(args)
        .current_dir(folder)
        .status()
        .unwrap();
    assert!(status.success(), "git {args:?} failed");
}

#[test]
fn since_a_commit_only_the_comments_it_added_are_judged() {
    let folder = folder("since");
    git(&folder, &["init", "--quiet"]);
    fs::write(
        folder.join("load.rs"),
        "fn load() {\n    // read the config file\n    let config = read_config_file();\n}\n",
    )
    .unwrap();
    git(&folder, &["add", "load.rs"]);
    git(&folder, &["commit", "--quiet", "-m", "load"]);
    fs::write(
        folder.join("load.rs"),
        "fn load() {\n    // read the config file\n    let config = read_config_file();\n    // parse the config\n    parse_config(config);\n}\n",
    )
    .unwrap();

    let output = run(&folder, &["check", "--since", "HEAD"]);

    assert_eq!(
        stdout(&output),
        "load.rs:4 restating-comment: the comment says what line 5 already says\n"
    );
    assert_eq!(output.status.code(), Some(1));
}

#[test]
fn since_is_only_ever_a_commit_to_git() {
    let folder = folder("since-option");
    git(&folder, &["init", "--quiet"]);

    let output = run(&folder, &["check", "--since=--output=written"]);

    assert!(!folder.join("written").exists(), "git took the commit for an option");
    assert_eq!(output.status.code(), Some(2));
}

#[test]
fn a_comment_that_says_why_is_left_alone() {
    let folder = folder("why");
    fs::write(
        folder.join("load.rs"),
        "fn load(path: &str) -> Config {\n    // the deploy mounts it read-only, so a missing file means a broken image\n    let config = read_config_file(path);\n    config\n}\n",
    )
    .unwrap();

    let output = run(&folder, &["check", "load.rs"]);

    assert_eq!(stdout(&output), "");
    assert_eq!(output.status.code(), Some(0));
}

#[test]
fn an_error_turned_into_an_option_and_dropped_is_found() {
    let folder = folder("ok-dropped");
    fs::write(
        folder.join("save.rs"),
        "fn save(path: &str, text: &str) -> bool {\n    fs::write(path, text).ok();\n    let saved = fs::write(path, text).ok();\n    saved.is_some()\n}\n",
    )
    .unwrap();

    let output = run(&folder, &["check", "save.rs"]);

    assert_eq!(
        stdout(&output),
        "save.rs:2 swallowed-error: the error is turned into an Option and dropped\n"
    );
    assert_eq!(output.status.code(), Some(1));
}

#[test]
fn a_call_bound_to_the_wildcard_is_found() {
    let folder = folder("let-underscore");
    fs::write(
        folder.join("save.rs"),
        "fn save(path: &str, text: &str) {\n    let _ = fs::write(path, text);\n    let _ = sender.send(text);\n    let _ = 3;\n}\n",
    )
    .unwrap();

    let output = run(&folder, &["check", "save.rs"]);

    assert_eq!(
        stdout(&output),
        "save.rs:2 swallowed-error: what the call returns, an error among it, is bound to _ and dropped\n\
         save.rs:3 swallowed-error: what the call returns, an error among it, is bound to _ and dropped\n"
    );
    assert_eq!(output.status.code(), Some(1));
}

#[test]
fn a_finding_spared_with_a_reason_is_not_reported() {
    let folder = folder("spared");
    fs::write(
        folder.join("draw.rs"),
        "fn draw() {\n    // orcrist: spare swallowed-error: a progress bar that fails to show changes nothing\n    io::stdout().flush().ok();\n    io::stderr().flush().ok(); // orcrist: spare swallowed-error: as above\n}\n",
    )
    .unwrap();

    let output = run(&folder, &["check", "draw.rs"]);

    assert_eq!(stdout(&output), "");
    assert_eq!(output.status.code(), Some(0));
}

#[test]
fn a_spare_without_a_reason_is_found_and_spares_nothing() {
    let folder = folder("unexplained");
    fs::write(
        folder.join("draw.rs"),
        "fn draw() {\n    io::stdout().flush().ok(); // orcrist: spare swallowed-error\n}\n",
    )
    .unwrap();

    let output = run(&folder, &["check", "draw.rs"]);

    assert_eq!(
        stdout(&output),
        "draw.rs:2 swallowed-error: the error is turned into an Option and dropped\n\
         draw.rs:2 unexplained-spare: a spare says why the finding is no slop here\n"
    );
    assert_eq!(output.status.code(), Some(1));
}

#[test]
fn only_a_comment_spares() {
    let folder = folder("spare-in-string");
    fs::write(
        folder.join("draw.rs"),
        "fn draw() {\n    let marker = \"orcrist: spare swallowed-error\";\n    io::stdout().flush().ok(); let why = \"orcrist: spare swallowed-error: in a string\";\n}\n",
    )
    .unwrap();

    let output = run(&folder, &["check", "draw.rs"]);

    assert_eq!(
        stdout(&output),
        "draw.rs:3 swallowed-error: the error is turned into an Option and dropped\n"
    );
    assert_eq!(output.status.code(), Some(1));
}
