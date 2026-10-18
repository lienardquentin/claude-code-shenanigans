//! The single-use-abstraction rule.

mod common;

use std::fs;
use std::path::Path;

use common::{check, folder, run, stdout};

#[test]
fn a_trait_with_one_implementation_in_the_project_is_found() {
    let folder = folder("one-implementation");
    fs::write(
        folder.join("store.rs"),
        "pub trait Store {\n    fn save(&self, text: &str);\n}\n\npub trait Clock {\n    fn now(&self) -> u64;\n}\n",
    )
    .unwrap();
    fs::write(
        folder.join("disk.rs"),
        "pub struct Disk;\n\nimpl Store for Disk {\n    fn save(&self, text: &str) {}\n}\n\nimpl crate::store::Clock for Disk {\n    fn now(&self) -> u64 { 0 }\n}\n\nimpl Clock for Wall {\n    fn now(&self) -> u64 { 1 }\n}\n",
    )
    .unwrap();

    let output = run(&folder, &["check", "store.rs", "disk.rs"]);

    assert_eq!(
        stdout(&output),
        "store.rs:1 single-use-abstraction: Store has one implementation, in disk.rs:3; the code could use it directly\n"
    );
    assert_eq!(output.status.code(), Some(1));
}

#[test]
fn a_python_abstract_class_with_one_subclass_is_found() {
    let output = check(
        "one-subclass",
        "store.py",
        "class Store(ABC):\n    @abstractmethod\n    def save(self, text: str) -> None: ...\n\n\nclass Disk(Store):\n    def save(self, text: str) -> None:\n        write(text)\n\n\nclass Clock(abc.ABC):\n    pass\n\n\nclass Wall(Clock):\n    pass\n\n\nclass Sun(Clock):\n    pass\n",
    );

    assert_eq!(
        stdout(&output),
        "store.py:1 single-use-abstraction: Store has one implementation, in store.py:6; the code could use it directly\n"
    );
    assert_eq!(output.status.code(), Some(1));
}

#[test]
fn a_typescript_interface_with_one_class_implementing_it_is_found() {
    let folder = folder("one-implementing-class");
    fs::write(
        folder.join("store.ts"),
        "export interface Store {\n  save(text: string): void\n}\n\nexport interface Beacon {\n  name: string\n}\n\nexport abstract class Clock {\n  abstract now(): number\n}\n",
    )
    .unwrap();
    fs::write(
        folder.join("disk.ts"),
        "export class Disk implements Store {\n  save(text: string) {}\n}\n\nexport class Wall extends Clock {\n  now() { return 0 }\n}\n",
    )
    .unwrap();

    let output = run(&folder, &["check", "store.ts", "disk.ts"]);

    assert_eq!(
        stdout(&output),
        "store.ts:1 single-use-abstraction: Store has one implementation, in disk.ts:1; the code could use it directly\n\
         store.ts:9 single-use-abstraction: Clock has one implementation, in disk.ts:5; the code could use it directly\n"
    );
    assert_eq!(output.status.code(), Some(1));
}

#[test]
fn a_parameter_every_caller_passes_the_same_value_for_is_found() {
    let folder = folder("constant-parameter");
    fs::write(
        folder.join("light.py"),
        "def light(beacon, keeper, retries):\n    send(beacon, keeper, retries)\n\n\ndef quench(beacon):\n    send(beacon)\n",
    )
    .unwrap();
    fs::write(
        folder.join("chain.py"),
        "def chain():\n    light(\"amon-din\", \"Hirgon\", 3)\n    light(\"eilenach\", \"Hirgon\", 3)\n    quench(\"amon-din\")\n",
    )
    .unwrap();

    let output = run(&folder, &["check", "light.py", "chain.py"]);

    assert_eq!(
        stdout(&output),
        "light.py:1 single-use-abstraction: every call passes \"Hirgon\" for keeper\n\
         light.py:1 single-use-abstraction: every call passes 3 for retries\n"
    );
    assert_eq!(output.status.code(), Some(1));
}

#[test]
fn interfaces_of_one_name_in_two_languages_are_two_interfaces() {
    let folder = folder("one-name-two-languages");
    fs::write(
        folder.join("store.rs"),
        "pub trait Store {\n    fn save(&self, text: &str);\n}\n\nimpl Store for Disk {\n    fn save(&self, text: &str) {}\n}\n",
    )
    .unwrap();
    fs::write(
        folder.join("store.ts"),
        "export interface Store {\n  save(text: string): void\n}\n\nexport class Disk implements Store {\n  save(text: string) {}\n}\n",
    )
    .unwrap();

    let output = run(&folder, &["check", "store.rs", "store.ts"]);

    assert_eq!(
        stdout(&output),
        "store.rs:1 single-use-abstraction: Store has one implementation, in store.rs:5; the code could use it directly\n\
         store.ts:1 single-use-abstraction: Store has one implementation, in store.ts:5; the code could use it directly\n"
    );
    assert_eq!(output.status.code(), Some(1));
}

// pins: deslop check fixtures/closures.rs
#[test]
fn a_rust_closure_held_by_a_name_is_a_function_its_parameters_its_own_names() {
    let output = run(
        Path::new(env!("CARGO_MANIFEST_DIR")),
        &["check", "fixtures/closures.rs"],
    );

    assert_eq!(
        stdout(&output),
        "fixtures/closures.rs:2 duplicate-helper: slug_of does what beacon_id in fixtures/closures.rs:7 already does\n\
         fixtures/closures.rs:7 duplicate-helper: beacon_id does what slug_of in fixtures/closures.rs:2 already does\n\
         fixtures/closures.rs:12 vague-name: handle says nothing of what it is\n\
         fixtures/closures.rs:17 duplicate-helper: measure does what weigh in fixtures/closures.rs:22 already does\n\
         fixtures/closures.rs:22 duplicate-helper: weigh does what measure in fixtures/closures.rs:17 already does\n"
    );
    assert_eq!(output.status.code(), Some(1));
}

// pins: deslop check fixtures/lambdas.py
#[test]
fn a_python_lambda_held_by_a_name_is_a_function_its_parameters_its_own_names() {
    let output = run(Path::new(env!("CARGO_MANIFEST_DIR")), &["check", "fixtures/lambdas.py"]);

    assert_eq!(
        stdout(&output),
        "fixtures/lambdas.py:1 single-use-abstraction: every call passes \"Hirgon\" for keeper\n\
         fixtures/lambdas.py:2 vague-name: process says nothing of what it is\n\
         fixtures/lambdas.py:7 duplicate-helper: shout does what yell in fixtures/lambdas.py:8 already does\n\
         fixtures/lambdas.py:8 duplicate-helper: yell does what shout in fixtures/lambdas.py:7 already does\n"
    );
    assert_eq!(output.status.code(), Some(1));
}

#[test]
fn a_rust_closure_and_a_free_function_of_one_name_are_each_judged_on_their_own_calls() {
    let output = check(
        "scoped-closure",
        "light.rs",
        "fn light(beacon: &str, keeper: &str) {\n    send(beacon, keeper);\n}\n\n\
         fn chain() {\n    light(\"amon-din\", \"Hirgon\");\n    light(\"eilenach\", \"Hirgon\");\n}\n\n\
         fn watch() {\n    let light = |beacon: &str, keeper: &str| send(beacon, keeper);\n    \
         light(\"min-rimmon\", \"Denethor\");\n    light(\"calenhad\", \"Denethor\");\n}\n",
    );

    assert_eq!(
        stdout(&output),
        "light.rs:1 single-use-abstraction: every call passes \"Hirgon\" for keeper\n\
         light.rs:11 single-use-abstraction: every call passes \"Denethor\" for keeper\n"
    );
    assert_eq!(output.status.code(), Some(1));
}

#[test]
fn a_python_module_function_is_judged_on_its_own_calls_beside_a_method_of_its_name() {
    let output = check(
        "scoped-method",
        "light.py",
        "class Tower:\n    def light(self, keeper):\n        send(self, keeper)\n\n\n\
         def light(beacon, keeper):\n    send(beacon, keeper)\n\n\n\
         light(\"amon-din\", \"Hirgon\")\nlight(\"eilenach\", \"Hirgon\")\n",
    );

    assert_eq!(
        stdout(&output),
        "light.py:6 single-use-abstraction: every call passes \"Hirgon\" for keeper\n"
    );
    assert_eq!(output.status.code(), Some(1));
}

#[test]
fn a_typescript_nested_arrow_and_the_top_level_function_it_shadows_are_each_judged_on_their_own_calls() {
    let output = check(
        "scoped-arrow",
        "light.ts",
        "function light(beacon: string, keeper: string) {\n  send(beacon, keeper)\n}\n\n\
         export function watch() {\n  const light = (beacon: string, keeper: string) => send(beacon, keeper)\n  \
         light('min-rimmon', 'Denethor')\n  light('calenhad', 'Denethor')\n}\n\n\
         light('amon-din', 'Hirgon')\nlight('eilenach', 'Hirgon')\n",
    );

    assert_eq!(
        stdout(&output),
        "light.ts:1 single-use-abstraction: every call passes 'Hirgon' for keeper\n\
         light.ts:6 single-use-abstraction: every call passes 'Denethor' for keeper\n"
    );
    assert_eq!(output.status.code(), Some(1));
}

#[test]
fn a_dot_call_to_a_name_both_a_method_and_a_free_function_hold_judges_neither() {
    let folder = folder("scoped-dot");
    fs::write(
        folder.join("light.ts"),
        "class Tower {\n  light(keeper: string) {\n    send(this, keeper)\n  }\n}\n\n\
         export function light(beacon: string, keeper: string) {\n  send(beacon, keeper)\n}\n\n\
         light('amon-din', 'Hirgon')\nlight('eilenach', 'Hirgon')\n",
    )
    .unwrap();
    fs::write(
        folder.join("watch.ts"),
        "export function watch(tower: Tower) {\n  tower.light('Denethor')\n  tower.light('Denethor')\n}\n",
    )
    .unwrap();

    let bare_calls_only = run(&folder, &["check", "light.ts"]);
    let with_dot_calls = run(&folder, &["check", "light.ts", "watch.ts"]);

    assert_eq!(
        stdout(&bare_calls_only),
        "light.ts:7 single-use-abstraction: every call passes 'Hirgon' for keeper\n"
    );
    assert_eq!(bare_calls_only.status.code(), Some(1));
    assert_eq!(stdout(&with_dot_calls), "");
    assert_eq!(with_dot_calls.status.code(), Some(0));
}

#[test]
fn a_rust_path_call_to_a_name_both_an_associated_and_a_free_function_hold_judges_neither() {
    let folder = folder("scoped-path");
    fs::write(
        folder.join("light.rs"),
        "fn light(beacon: &str, keeper: &str) {\n    send(beacon, keeper);\n}\n\n\
         struct Disk;\n\nimpl Disk {\n    fn light(keeper: &str) {\n        send(\"disk\", keeper);\n    }\n}\n\n\
         fn chain() {\n    light(\"amon-din\", \"Hirgon\");\n    light(\"eilenach\", \"Hirgon\");\n}\n",
    )
    .unwrap();
    fs::write(
        folder.join("watch.rs"),
        "fn watch() {\n    Disk::light(\"Denethor\");\n    Disk::light(\"Denethor\");\n}\n",
    )
    .unwrap();

    let bare_calls_only = run(&folder, &["check", "light.rs"]);
    let with_path_calls = run(&folder, &["check", "light.rs", "watch.rs"]);

    assert_eq!(
        stdout(&bare_calls_only),
        "light.rs:1 single-use-abstraction: every call passes \"Hirgon\" for keeper\n"
    );
    assert_eq!(bare_calls_only.status.code(), Some(1));
    assert_eq!(stdout(&with_path_calls), "");
    assert_eq!(with_path_calls.status.code(), Some(0));
}

// pins: deslop check fixtures/scoped.py
#[test]
fn a_method_and_a_function_of_one_name_in_a_fixture_are_each_judged_on_their_own_calls() {
    let output = run(Path::new(env!("CARGO_MANIFEST_DIR")), &["check", "fixtures/scoped.py"]);

    // The fixture holds a method and a function of one name, each called with one literal: one finding for each, on
    // lines of their own
    let found = stdout(&output);
    let lines: Vec<&str> = found.lines().collect();
    assert_eq!(lines.len(), 2, "{found}");
    for line in &lines {
        assert!(line.starts_with("fixtures/scoped.py:"), "{found}");
        assert!(line.contains(" single-use-abstraction: every call passes "), "{found}");
    }
    let line_of = |finding: &str| finding.split(' ').next().unwrap().to_string();
    assert_ne!(line_of(lines[0]), line_of(lines[1]), "{found}");
    assert_eq!(output.status.code(), Some(1));
}
