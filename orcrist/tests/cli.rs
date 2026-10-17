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
fn since_a_commit_a_file_git_does_not_track_yet_is_judged_whole() {
    let folder = folder("since-untracked");
    git(&folder, &["init", "--quiet"]);
    git(&folder, &["commit", "--quiet", "--allow-empty", "-m", "start"]);
    fs::write(
        folder.join("load.rs"),
        "fn load() {\n    // read the config file\n    let config = read_config_file();\n}\n",
    )
    .unwrap();

    let output = run(&folder, &["check", "--since", "HEAD"]);

    assert_eq!(
        stdout(&output),
        "load.rs:2 restating-comment: the comment says what line 3 already says\n"
    );
    assert_eq!(output.status.code(), Some(1));
}

#[test]
fn since_a_commit_a_file_whose_name_git_quotes_is_judged() {
    let folder = folder("since-quoted");
    git(&folder, &["init", "--quiet"]);
    fs::write(folder.join("été.rs"), "fn load() {}\n").unwrap();
    git(&folder, &["add", "été.rs"]);
    git(&folder, &["commit", "--quiet", "-m", "load"]);
    fs::write(
        folder.join("été.rs"),
        "fn load() {\n    // read the config file\n    let config = read_config_file();\n}\n",
    )
    .unwrap();

    let output = run(&folder, &["check", "--since", "HEAD"]);

    assert_eq!(
        stdout(&output),
        "été.rs:2 restating-comment: the comment says what line 3 already says\n"
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

/// orcrist run on one file of the given name and source, in a folder of the test's own.
fn check(test: &str, name: &str, source: &str) -> Output {
    let folder = folder(test);
    fs::write(folder.join(name), source).unwrap();
    run(&folder, &["check", name])
}

#[test]
fn a_python_comment_that_restates_its_line_is_found() {
    let output = check(
        "python-restating",
        "load.py",
        "def load(path):\n    # read the config file\n    config = read_config_file(path)\n    return config\n",
    );

    assert_eq!(
        stdout(&output),
        "load.py:2 restating-comment: the comment says what line 3 already says\n"
    );
    assert_eq!(output.status.code(), Some(1));
}

#[test]
fn a_file_of_a_language_orcrist_does_not_read_is_refused() {
    let output = check(
        "unknown-language",
        "notes.txt",
        "// read the config file\nread_config_file()\n",
    );

    assert_eq!(
        String::from_utf8(output.stderr.clone()).unwrap(),
        "orcrist: no language orcrist reads has the extension of notes.txt\n"
    );
    assert_eq!(stdout(&output), "");
    assert_eq!(output.status.code(), Some(2));
}

#[test]
fn a_python_except_that_only_passes_is_found() {
    let output = check(
        "python-except-pass",
        "save.py",
        "def save(path, text):\n    try:\n        write(path, text)\n    except OSError:\n        pass\n    try:\n        write(path, text)\n    except OSError:\n        log.warning(\"not saved\")\n",
    );

    assert_eq!(
        stdout(&output),
        "save.py:4 swallowed-error: the error is caught and nothing is done with it\n"
    );
    assert_eq!(output.status.code(), Some(1));
}

#[test]
fn a_typescript_comment_that_restates_its_line_is_found() {
    let output = check(
        "typescript-restating",
        "load.ts",
        "export function load(path: string): Config {\n  // read the config file\n  const config = readConfigFile(path)\n  return config\n}\n",
    );

    assert_eq!(
        stdout(&output),
        "load.ts:2 restating-comment: the comment says what line 3 already says\n"
    );
    assert_eq!(output.status.code(), Some(1));
}

#[test]
fn a_typescript_catch_that_does_nothing_is_found() {
    let output = check(
        "typescript-empty-catch",
        "save.ts",
        "export async function save(path: string, text: string) {\n  try {\n    await write(path, text)\n  } catch {}\n  await write(path, text).catch(() => {})\n  await write(path, text).catch((error) => report(error))\n}\n",
    );

    assert_eq!(
        stdout(&output),
        "save.ts:4 swallowed-error: the error is caught and nothing is done with it\n\
         save.ts:5 swallowed-error: the error is caught and nothing is done with it\n"
    );
    assert_eq!(output.status.code(), Some(1));
}

#[test]
fn the_script_of_a_vue_component_is_judged_where_it_stands() {
    let output = check(
        "vue",
        "Load.vue",
        "<template>\n  <!-- read the config file -->\n  <p>{{ config }}</p>\n</template>\n\n<script setup lang=\"ts\">\n// read the config file\nconst config = readConfigFile()\n</script>\n",
    );

    assert_eq!(
        stdout(&output),
        "Load.vue:7 restating-comment: the comment says what line 8 already says\n"
    );
    assert_eq!(output.status.code(), Some(1));
}

#[test]
fn a_python_except_that_lets_ctrl_c_stop_quietly_is_left_alone() {
    let output = check(
        "python-keyboard-interrupt",
        "serve.py",
        "def serve():\n    try:\n        loop()\n    except KeyboardInterrupt:\n        pass\n",
    );

    assert_eq!(stdout(&output), "");
    assert_eq!(output.status.code(), Some(0));
}
