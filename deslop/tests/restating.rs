//! The restating-comment rule.

mod common;

use common::{check, stdout};

#[test]
fn a_comment_that_restates_its_line_is_found() {
    let output = check(
        "restating",
        "load.rs",
        "fn load(path: &str) -> Config {\n    // read the config file\n    let config = read_config_file(path);\n    config\n}\n",
    );

    assert_eq!(
        stdout(&output),
        "load.rs:2 restating-comment: the comment says what line 3 already says\n"
    );
    assert_eq!(output.status.code(), Some(1));
}

#[test]
fn a_comment_that_says_why_is_left_alone() {
    let output = check(
        "why",
        "load.rs",
        "fn load(path: &str) -> Config {\n    // the deploy mounts it read-only, so a missing file means a broken image\n    let config = read_config_file(path);\n    config\n}\n",
    );

    assert_eq!(stdout(&output), "");
    assert_eq!(output.status.code(), Some(0));
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
