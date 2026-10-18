//! The duplicate-helper rule.

mod common;

use std::fs;
use std::path::Path;

use common::{check, folder, git, run, stdout};

#[test]
fn a_function_that_does_what_another_already_does_is_found() {
    let folder = folder("duplicate");
    git(&folder, &["init", "--quiet"]);
    fs::write(
        folder.join("names.ts"),
        "export function slugOf(name: string): string {\n  const lowered = name.trim().toLowerCase()\n  const joined = lowered.split(' ').join('-')\n  return joined.replace(/[^a-z-]/g, '')\n}\n",
    )
    .unwrap();
    fs::write(
        folder.join("beacons.ts"),
        "export function beaconId(title: string): string {\n  const small = title.trim().toLowerCase()\n  const dashed = small.split(' ').join('-')\n  return dashed.replace(/[^a-z-]/g, '')\n}\n\nexport function realmId(title: string): string {\n  const small = title.trim().toUpperCase()\n  const dashed = small.split(' ').join('_')\n  return dashed.replace(/[^A-Z_]/g, '')\n}\n",
    )
    .unwrap();

    let output = run(&folder, &["check", "beacons.ts"]);

    assert_eq!(
        stdout(&output),
        "beacons.ts:1 duplicate-helper: beaconId does what slugOf in names.ts:1 already does\n"
    );
    assert_eq!(output.status.code(), Some(1));
}

// pins: deslop check fixtures/arrows.ts
#[test]
fn functions_held_by_constants_are_compared_and_a_comment_is_not_held_against_the_next() {
    let output = run(Path::new(env!("CARGO_MANIFEST_DIR")), &["check", "fixtures/arrows.ts"]);

    assert_eq!(
        stdout(&output),
        "fixtures/arrows.ts:5 duplicate-helper: slugOf does what beaconId in fixtures/arrows.ts:11 already does\n\
         fixtures/arrows.ts:11 duplicate-helper: beaconId does what slugOf in fixtures/arrows.ts:5 already does\n\
         fixtures/arrows.ts:17 single-use-abstraction: every call passes 'Hirgon' for keeper\n\
         fixtures/arrows.ts:22 duplicate-helper: keeperOf does what wardenOf in fixtures/arrows.ts:28 already does\n\
         fixtures/arrows.ts:28 duplicate-helper: wardenOf does what keeperOf in fixtures/arrows.ts:22 already does\n\
         fixtures/arrows.ts:34 duplicate-helper: towerOf does what realmOf in fixtures/arrows.ts:40 already does\n\
         fixtures/arrows.ts:40 duplicate-helper: realmOf does what towerOf in fixtures/arrows.ts:34 already does\n"
    );
    assert_eq!(output.status.code(), Some(1));
}

#[test]
fn small_functions_alike_by_chance_are_left_alone() {
    let output = check(
        "duplicate-small",
        "beacon.rs",
        "impl Beacon {\n    fn name(&self) -> &str {\n        &self.name\n    }\n\n    fn keeper(&self) -> &str {\n        &self.name\n    }\n}\n",
    );

    assert_eq!(stdout(&output), "");
    assert_eq!(output.status.code(), Some(0));
}
