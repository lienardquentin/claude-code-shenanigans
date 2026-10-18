//! The comment that spares a finding, and the unexplained-spare rule.

mod common;

use common::{check, stdout};

#[test]
fn a_finding_spared_with_a_reason_is_not_reported() {
    let output = check(
        "spared",
        "draw.rs",
        "fn draw() {\n    // deslop: spare swallowed-error: a progress bar that fails to show changes nothing\n    io::stdout().flush().ok();\n    io::stderr().flush().ok(); // deslop: spare swallowed-error: as above\n}\n",
    );

    assert_eq!(stdout(&output), "");
    assert_eq!(output.status.code(), Some(0));
}

#[test]
fn a_spare_without_a_reason_is_found_and_spares_nothing() {
    let output = check(
        "unexplained",
        "draw.rs",
        "fn draw() {\n    io::stdout().flush().ok(); // deslop: spare swallowed-error\n}\n",
    );

    assert_eq!(
        stdout(&output),
        "draw.rs:2 swallowed-error: the error is turned into an Option and dropped\n\
         draw.rs:2 unexplained-spare: a spare says why the finding is no slop here\n"
    );
    assert_eq!(output.status.code(), Some(1));
}

#[test]
fn only_a_comment_spares() {
    let output = check(
        "spare-in-string",
        "draw.rs",
        "fn draw() {\n    let marker = \"deslop: spare swallowed-error\";\n    io::stdout().flush().ok(); let why = \"deslop: spare swallowed-error: in a string\";\n}\n",
    );

    assert_eq!(
        stdout(&output),
        "draw.rs:3 swallowed-error: the error is turned into an Option and dropped\n"
    );
    assert_eq!(output.status.code(), Some(1));
}

#[test]
fn the_old_spelling_of_a_spare_still_spares_and_is_said_once_to_be_deprecated() {
    let output = check(
        "spare-old-name",
        "draw.rs",
        "fn draw() {\n    io::stdout().flush().ok(); // orcrist: spare swallowed-error: as above\n    io::stderr().flush().ok(); // orcrist: spare swallowed-error: as above\n}\n",
    );

    assert_eq!(stdout(&output), "");
    assert_eq!(output.status.code(), Some(0));
    assert_eq!(
        String::from_utf8(output.stderr).unwrap(),
        "deslop: `orcrist: spare` is deprecated, write `deslop: spare`\n"
    );
}
