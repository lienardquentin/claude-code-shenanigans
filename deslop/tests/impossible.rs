//! The impossible-guard rule.

mod common;

use std::path::Path;

use common::{check, run, stdout};

#[test]
fn a_python_guard_its_signature_rules_out_is_found() {
    let output = check(
        "impossible-python",
        "save.py",
        "def save(path: str, text: str, mode: Optional[str] = None, keeper: str | None = None):\n    if not isinstance(path, str):\n        raise TypeError(path)\n    if text is None:\n        return\n    if mode is None:\n        mode = \"w\"\n    if keeper is None:\n        keeper = \"Hirgon\"\n    write(path, text, mode, keeper)\n",
    );

    assert_eq!(
        stdout(&output),
        "save.py:2 impossible-guard: the signature already says path is str\n\
         save.py:4 impossible-guard: the signature already says text is str\n"
    );
    assert_eq!(output.status.code(), Some(1));
}

#[test]
fn a_typescript_guard_its_signature_rules_out_is_found() {
    let output = check(
        "impossible-typescript",
        "save.ts",
        "export function save(path: string, text: string, mode?: string, keeper: string | null = null) {\n  if (path == null) throw new Error('no path')\n  if (typeof text !== 'string') return\n  const length = text?.length\n  if (mode === undefined) mode = 'w'\n  if (keeper === null) keeper = 'Hirgon'\n  write(path, text, mode, keeper, length)\n}\n",
    );

    assert_eq!(
        stdout(&output),
        "save.ts:2 impossible-guard: the signature already says path is string\n\
         save.ts:3 impossible-guard: the signature already says text is string\n\
         save.ts:4 impossible-guard: the signature already says text is string\n"
    );
    assert_eq!(output.status.code(), Some(1));
}

#[test]
fn a_guard_on_a_parameter_the_function_assigns_to_is_left_alone() {
    let output = check(
        "impossible-reassigned",
        "save.py",
        "def save(path: str):\n    path = lookup(path)\n    if path is None:\n        return\n    write(path)\n",
    );

    assert_eq!(stdout(&output), "");
    assert_eq!(output.status.code(), Some(0));
}

// pins: deslop check fixtures/precise.ts
#[test]
fn typescript_is_judged_where_deslop_knows_and_left_alone_where_it_guesses() {
    let output = run(Path::new(env!("CARGO_MANIFEST_DIR")), &["check", "fixtures/precise.ts"]);

    // An alias's or a generic's values are not known, and a comment after code speaks of its own line
    assert_eq!(
        stdout(&output),
        "fixtures/precise.ts:9 swallowed-error: the error is caught and nothing is done with it\n\
         fixtures/precise.ts:12 impossible-guard: the signature already says text is string\n"
    );
    assert_eq!(output.status.code(), Some(1));
}

// pins: deslop check fixtures/precise.py
#[test]
fn python_is_judged_where_deslop_knows_and_left_alone_where_it_guesses() {
    let output = run(Path::new(env!("CARGO_MANIFEST_DIR")), &["check", "fixtures/precise.py"]);

    // An optional import is meant, an alias's values are not known, and `...` does as little as `pass`
    assert_eq!(
        stdout(&output),
        "fixtures/precise.py:12 swallowed-error: the error is caught and nothing is done with it\n\
         fixtures/precise.py:14 impossible-guard: the signature already says path is str\n\
         fixtures/precise.py:24 swallowed-error: the error is caught and nothing is done with it\n"
    );
    assert_eq!(output.status.code(), Some(1));
}
