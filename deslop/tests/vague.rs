//! The vague-name rule.

mod common;

use std::path::Path;

use common::{check, folder, run, stdout, write};

#[test]
fn a_name_made_only_of_vague_words_is_found() {
    let output = check(
        "vague-rust",
        "load.rs",
        "fn process_data(info: &str) -> Config {\n    let tmp2 = parse(info);\n    let user_data = tmp2.users();\n    Config::new(user_data)\n}\n",
    );

    assert_eq!(
        stdout(&output),
        "load.rs:1 vague-name: process_data says nothing of what it is\n\
         load.rs:1 vague-name: info says nothing of what it is\n\
         load.rs:2 vague-name: tmp2 says nothing of what it is\n"
    );
    assert_eq!(output.status.code(), Some(1));
}

#[test]
fn a_python_name_made_only_of_vague_words_is_found() {
    let output = check(
        "vague-python",
        "load.py",
        "def handle_data(info, path):\n    tmp = parse(info)\n    users = tmp.users()\n    return users\n",
    );

    assert_eq!(
        stdout(&output),
        "load.py:1 vague-name: handle_data says nothing of what it is\n\
         load.py:1 vague-name: info says nothing of what it is\n\
         load.py:2 vague-name: tmp says nothing of what it is\n"
    );
    assert_eq!(output.status.code(), Some(1));
}

#[test]
fn a_typescript_name_made_only_of_vague_words_is_found() {
    let output = check(
        "vague-typescript",
        "load.ts",
        "export function processData(info: string, path: string) {\n  const tmp = parse(info)\n  const doStuff = () => tmp.users()\n  return doStuff()\n}\n",
    );

    assert_eq!(
        stdout(&output),
        "load.ts:1 vague-name: processData says nothing of what it is\n\
         load.ts:1 vague-name: info says nothing of what it is\n\
         load.ts:2 vague-name: tmp says nothing of what it is\n\
         load.ts:3 vague-name: doStuff says nothing of what it is\n"
    );
    assert_eq!(output.status.code(), Some(1));
}

#[test]
fn a_vague_verb_is_vague_only_as_a_function_name() {
    let output = check(
        "vague-verb",
        "serve.py",
        "def process(command):\n    handle = open_log()\n    process = subprocess.Popen(command, stdout=handle)\n    return process\n",
    );

    assert_eq!(
        stdout(&output),
        "serve.py:1 vague-name: process says nothing of what it is\n"
    );
    assert_eq!(output.status.code(), Some(1));
}

// pins: deslop check fixtures/clean/cart.ts
#[test]
fn an_element_named_for_its_collection_is_not_vague() {
    let output = run(
        Path::new(env!("CARGO_MANIFEST_DIR")),
        &["check", "fixtures/clean/cart.ts"],
    );

    assert_eq!(stdout(&output), "");
    assert_eq!(output.status.code(), Some(0));
}

#[test]
fn an_element_of_a_collection_named_otherwise_is_still_vague() {
    let output = check(
        "element-of-data",
        "names.ts",
        "export const names = (beacons: Beacon[]) => beacons.map((item) => item.name)\nexport const fetched = () => load().then((data) => show(data))\n",
    );

    assert_eq!(
        stdout(&output),
        "names.ts:1 vague-name: item says nothing of what it is\n\
         names.ts:2 vague-name: data says nothing of what it is\n"
    );
    assert_eq!(output.status.code(), Some(1));
}

// pins: deslop check --root fixtures/allowing api.py
#[test]
fn a_project_judged_from_its_root_may_allow_a_built_in_vague_word() {
    let output = run(
        Path::new(env!("CARGO_MANIFEST_DIR")),
        &["check", "--root", "fixtures/allowing", "api.py"],
    );

    // `data` is the API's own word there; `info` is still vague; the path is the root's
    assert_eq!(
        stdout(&output),
        "api.py:2 vague-name: info says nothing of what it is\n"
    );
    assert_eq!(output.status.code(), Some(1));
}

#[test]
fn an_allowed_word_is_read_as_a_name_s_word_its_digits_aside() {
    let folder = folder("allow-digits");
    write(
        &folder,
        &[
            ("deslop.toml", "[rules.vague-name]\nallow = [\"Data2\"]\n"),
            ("load.ts", "export const data3 = 1\n"),
        ],
    );

    let output = run(&folder, &["check", "load.ts"]);

    assert_eq!(stdout(&output), "");
    assert_eq!(output.status.code(), Some(0));
}
