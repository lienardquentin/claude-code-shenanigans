//! The swallowed-error rule.

mod common;

use std::path::Path;

use common::{check, run, stdout};

#[test]
fn an_error_turned_into_an_option_and_dropped_is_found() {
    let output = check(
        "ok-dropped",
        "save.rs",
        "fn save(path: &str, text: &str) -> bool {\n    fs::write(path, text).ok();\n    let saved = fs::write(path, text).ok();\n    saved.is_some()\n}\n",
    );

    assert_eq!(
        stdout(&output),
        "save.rs:2 swallowed-error: the error is turned into an Option and dropped\n"
    );
    assert_eq!(output.status.code(), Some(1));
}

#[test]
fn a_call_bound_to_the_wildcard_is_found() {
    let output = check(
        "let-underscore",
        "save.rs",
        "fn save(path: &str, text: &str) {\n    let _ = fs::write(path, text);\n    let _ = sender.send(text);\n    let _ = 3;\n}\n",
    );

    assert_eq!(
        stdout(&output),
        "save.rs:2 swallowed-error: what the call returns, an error among it, is bound to _ and dropped\n\
         save.rs:3 swallowed-error: what the call returns, an error among it, is bound to _ and dropped\n"
    );
    assert_eq!(output.status.code(), Some(1));
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
fn a_python_except_that_lets_ctrl_c_stop_quietly_is_left_alone() {
    let output = check(
        "python-keyboard-interrupt",
        "serve.py",
        "def serve():\n    try:\n        loop()\n    except KeyboardInterrupt:\n        pass\n",
    );

    assert_eq!(stdout(&output), "");
    assert_eq!(output.status.code(), Some(0));
}

// pins: deslop check fixtures/precise.rs
#[test]
fn an_error_matched_and_left_is_swallowed() {
    let output = run(Path::new(env!("CARGO_MANIFEST_DIR")), &["check", "fixtures/precise.rs"]);

    assert_eq!(
        stdout(&output),
        "fixtures/precise.rs:2 swallowed-error: the error is matched and nothing is done with it\n"
    );
    assert_eq!(output.status.code(), Some(1));
}
