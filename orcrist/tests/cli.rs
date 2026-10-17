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

// orcrist: spare duplicate-helper: narsil's tests are another crate, which these cannot share a helper with
fn stdout(output: &Output) -> String {
    String::from_utf8(output.stdout.clone()).unwrap()
}

/// orcrist run on one file of the given name and source, in a folder of the test's own.
fn check(test: &str, name: &str, source: &str) -> Output {
    let folder = folder(test);
    fs::write(folder.join(name), source).unwrap();
    run(&folder, &["check", name])
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
fn since_a_commit_what_orcrist_cannot_read_is_named_and_jsx_is_read() {
    let folder = folder("since-unread");
    git(&folder, &["init", "--quiet"]);
    fs::write(folder.join("old.md"), "# Beacons\n").unwrap();
    fs::write(folder.join("README.md"), "# Beacons\n").unwrap();
    git(&folder, &["add", "old.md", "README.md"]);
    git(&folder, &["commit", "--quiet", "-m", "start"]);
    fs::remove_file(folder.join("old.md")).unwrap();
    fs::write(folder.join("README.md"), "# Beacons\n\nLit in order.\n").unwrap();
    fs::write(folder.join("Makefile"), "all:\n").unwrap();
    fs::write(
        folder.join("Beacon.tsx"),
        "// light the beacon\nconst beacon = lightBeacon()\nexport const Beacon = () => <p>{beacon}</p>\n",
    )
    .unwrap();

    let output = run(&folder, &["check", "--since", "HEAD"]);

    assert_eq!(
        stdout(&output),
        "Beacon.tsx:1 restating-comment: the comment says what line 2 already says\n"
    );
    assert_eq!(
        String::from_utf8(output.stderr.clone()).unwrap(),
        "orcrist: left unjudged, of no language orcrist reads: 1 .md, 1 Makefile\n"
    );
    assert_eq!(output.status.code(), Some(1));
}

#[test]
fn a_project_file_that_is_not_text_is_left_out_and_the_judged_file_is_still_judged() {
    let folder = folder("not-text");
    git(&folder, &["init", "--quiet"]);
    fs::write(folder.join("bundle.js"), b"var a = '\xff\xfe';\n").unwrap();
    fs::write(
        folder.join("load.rs"),
        "fn load() {\n    // read the config file\n    let config = read_config_file();\n}\n",
    )
    .unwrap();

    let output = run(&folder, &["check", "load.rs"]);

    assert_eq!(
        stdout(&output),
        "load.rs:2 restating-comment: the comment says what line 3 already says\n"
    );
    assert!(
        String::from_utf8(output.stderr.clone())
            .unwrap()
            .starts_with("orcrist: left out of the project: cannot read bundle.js: "),
        "{output:?}"
    );
    assert_eq!(output.status.code(), Some(1));
}

#[test]
fn since_is_only_ever_a_commit_to_git() {
    let folder = folder("since-option");
    git(&folder, &["init", "--quiet"]);

    let output = run(&folder, &["check", "--since=--output=written"]);

    // Refused as no commit before any git command could take it for an option, as `--output=written:orcrist.toml`
    let written: Vec<_> = fs::read_dir(&folder)
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .filter(|name| name.to_string_lossy().starts_with("written"))
        .collect();
    assert!(written.is_empty(), "git took the commit for an option: {written:?}");
    assert_eq!(output.status.code(), Some(2));
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
fn a_finding_spared_with_a_reason_is_not_reported() {
    let output = check(
        "spared",
        "draw.rs",
        "fn draw() {\n    // orcrist: spare swallowed-error: a progress bar that fails to show changes nothing\n    io::stdout().flush().ok();\n    io::stderr().flush().ok(); // orcrist: spare swallowed-error: as above\n}\n",
    );

    assert_eq!(stdout(&output), "");
    assert_eq!(output.status.code(), Some(0));
}

#[test]
fn a_spare_without_a_reason_is_found_and_spares_nothing() {
    let output = check(
        "unexplained",
        "draw.rs",
        "fn draw() {\n    io::stdout().flush().ok(); // orcrist: spare swallowed-error\n}\n",
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
        "fn draw() {\n    let marker = \"orcrist: spare swallowed-error\";\n    io::stdout().flush().ok(); let why = \"orcrist: spare swallowed-error: in a string\";\n}\n",
    );

    assert_eq!(
        stdout(&output),
        "draw.rs:3 swallowed-error: the error is turned into an Option and dropped\n"
    );
    assert_eq!(output.status.code(), Some(1));
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

// sting: orcrist check fixtures/Beacons.tsx
#[test]
fn a_tsx_component_is_judged_as_typescript() {
    let output = run(
        Path::new(env!("CARGO_MANIFEST_DIR")),
        &["check", "fixtures/Beacons.tsx"],
    );

    assert_eq!(
        stdout(&output),
        "fixtures/Beacons.tsx:1 restating-comment: the comment says what line 2 already says\n\
         fixtures/Beacons.tsx:7 swallowed-error: the error is caught and nothing is done with it\n\
         fixtures/Beacons.tsx:11 vague-name: processData says nothing of what it is\n\
         fixtures/Beacons.tsx:11 vague-name: info says nothing of what it is\n\
         fixtures/Beacons.tsx:12 impossible-guard: the signature already says info is string\n"
    );
    assert_eq!(output.status.code(), Some(1));
}

// sting: orcrist check fixtures/light.js
#[test]
fn javascript_is_judged_as_typescript_without_annotations() {
    let output = run(Path::new(env!("CARGO_MANIFEST_DIR")), &["check", "fixtures/light.js"]);

    assert_eq!(
        stdout(&output),
        "fixtures/light.js:1 restating-comment: the comment says what line 2 already says\n\
         fixtures/light.js:4 vague-name: handle says nothing of what it is\n\
         fixtures/light.js:4 vague-name: data says nothing of what it is\n\
         fixtures/light.js:5 swallowed-error: the error is caught and nothing is done with it\n"
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

// sting: orcrist check fixtures/arrows.ts
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

/// Writes each file, its folders made first.
fn write(folder: &Path, files: &[(&str, &str)]) {
    for (name, text) in files {
        let path = folder.join(name);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }
}

const SLUG_OF: &str = "export function slugOf(name: string): string {\n  const lowered = name.trim().toLowerCase()\n  const joined = lowered.split(' ').join('-')\n  return joined.replace(/[^a-z-]/g, '')\n}\n";

// sting: orcrist check fixtures/configured/load.ts
#[test]
fn orcrists_own_config_skips_vague_names_in_the_configured_fixtures() {
    let output = run(
        Path::new(env!("CARGO_MANIFEST_DIR")),
        &["check", "fixtures/configured/load.ts"],
    );

    assert_eq!(
        stdout(&output),
        "fixtures/configured/load.ts:1 restating-comment: the comment says what line 2 already says\n"
    );
    assert_eq!(output.status.code(), Some(1));
}

#[test]
fn the_config_leaves_paths_out_skips_a_rule_where_it_says_and_turns_one_off() {
    let folder = folder("config-ignore-skip-off");
    git(&folder, &["init", "--quiet"]);
    write(
        &folder,
        &[
            (
                "orcrist.toml",
                "ignore = [\"dist/**\"]\n\n[rules.duplicate-helper]\nskip = [\"src/kit/*\"]\n\n[rules.vague-name]\noff = true\n",
            ),
            ("dist/bundle.ts", SLUG_OF),
            ("src/kit/slug.ts", SLUG_OF),
            (
                "src/names.ts",
                &format!("{SLUG_OF}\nexport const data = slugOf('Amon Din')\n"),
            ),
        ],
    );

    let names = run(&folder, &["check", "src/names.ts"]);
    let kit = run(&folder, &["check", "src/kit/slug.ts"]);
    let kit_absolute = run(&folder, &["check", folder.join("src/kit/slug.ts").to_str().unwrap()]);

    assert_eq!(
        stdout(&names),
        "src/names.ts:1 duplicate-helper: slugOf does what slugOf in src/kit/slug.ts:1 already does\n"
    );
    assert_eq!(names.status.code(), Some(1));
    assert_eq!(stdout(&kit), "");
    assert_eq!(kit.status.code(), Some(0));
    assert_eq!(stdout(&kit_absolute), "");
    assert_eq!(kit_absolute.status.code(), Some(0));
}

#[test]
fn since_a_commit_what_the_config_ignores_is_neither_judged_nor_named() {
    let folder = folder("config-since-ignore");
    git(&folder, &["init", "--quiet"]);
    write(&folder, &[("orcrist.toml", "ignore = [\"dist/**\"]\n")]);
    git(&folder, &["add", "orcrist.toml"]);
    git(&folder, &["commit", "--quiet", "-m", "start"]);
    let load = "// read the config file\nconst config = readConfigFile()\n";
    write(
        &folder,
        &[
            ("dist/bundle.ts", load),
            ("dist/app.css", "p {}\n"),
            ("src/load.ts", load),
            ("notes.md", "# Beacons\n"),
        ],
    );

    let output = run(&folder, &["check", "--since", "HEAD"]);

    assert_eq!(
        stdout(&output),
        "src/load.ts:1 restating-comment: the comment says what line 2 already says\n"
    );
    assert_eq!(
        String::from_utf8(output.stderr.clone()).unwrap(),
        "orcrist: left unjudged, of no language orcrist reads: 1 .md\n"
    );
    assert_eq!(output.status.code(), Some(1));
}

#[test]
fn the_config_is_found_above_the_current_folder_but_not_above_the_repository() {
    let folder = folder("config-above");
    let load = "// read the config file\nconst data = readConfigFile()\n";
    write(
        &folder,
        &[
            ("orcrist.toml", "[rules.vague-name]\noff = true\n"),
            (
                "configured/orcrist.toml",
                "[rules.restating-comment]\nskip = [\"app/**\"]\n",
            ),
            ("configured/app/load.ts", load),
            ("bare/app/load.ts", load),
        ],
    );
    git(&folder.join("configured"), &["init", "--quiet"]);
    git(&folder.join("bare"), &["init", "--quiet"]);

    let configured = run(&folder.join("configured/app"), &["check", "load.ts"]);
    let bare = run(&folder.join("bare/app"), &["check", "load.ts"]);

    assert_eq!(
        stdout(&configured),
        "load.ts:2 vague-name: data says nothing of what it is\n"
    );
    assert_eq!(configured.status.code(), Some(1));
    assert_eq!(
        stdout(&bare),
        "load.ts:1 restating-comment: the comment says what line 2 already says\n\
         load.ts:2 vague-name: data says nothing of what it is\n"
    );
    assert_eq!(bare.status.code(), Some(1));
}

#[test]
fn outside_a_repository_only_the_current_folder_holds_the_config() {
    let folder = folder("config-outside");
    write(
        &folder,
        &[
            ("orcrist.toml", "ignore = [\"**\"]\n\n[rules.vague-name]\noff = true\n"),
            ("app/load.ts", "const data = readConfigFile()\n"),
        ],
    );

    let output = run(&folder.join("app"), &["check", "load.ts"]);

    assert_eq!(
        stdout(&output),
        "load.ts:1 vague-name: data says nothing of what it is\n"
    );
    assert_eq!(output.status.code(), Some(1));
}

#[test]
fn the_config_sets_the_thresholds_and_adds_words() {
    let folder = folder("config-settings");
    write(
        &folder,
        &[
            (
                "orcrist.toml",
                "[rules.restating-comment]\nshare = 0.5\nfiller = [\"we\"]\n\n[rules.vague-name]\nwords = [\"Blob\"]\nverbs = [\"execute\"]\n\n[rules.duplicate-helper]\nsmallest = 1000\n\n[rules.single-use-abstraction]\ncalls = 3\n",
            ),
            (
                "beacons.py",
                "def execute(blob, path):\n    # we read the beacons, we do it twice\n    beacons = read_beacons(path)\n    return beacons\n\n\ndef slug_of(name):\n    lowered = name.strip().lower()\n    joined = \"-\".join(lowered.split(\" \"))\n    return joined.replace(\"_\", \"-\")\n\n\ndef beacon_id(title):\n    small = title.strip().lower()\n    dashed = \"-\".join(small.split(\" \"))\n    return dashed.replace(\"_\", \"-\")\n\n\ndef light(beacon, keeper):\n    send(beacon, keeper)\n\n\nlight(\"amon-din\", \"Hirgon\")\nlight(\"eilenach\", \"Hirgon\")\n",
            ),
        ],
    );

    let output = run(&folder, &["check", "beacons.py"]);

    assert_eq!(
        stdout(&output),
        "beacons.py:1 vague-name: execute says nothing of what it is\n\
         beacons.py:1 vague-name: blob says nothing of what it is\n\
         beacons.py:2 restating-comment: the comment says what line 3 already says\n"
    );
    assert_eq!(output.status.code(), Some(1));
}

#[test]
fn a_config_that_says_what_orcrist_does_not_understand_is_refused() {
    for (test, config, says) in [
        (
            "config-unknown-rule",
            "[rules.vauge-name]\noff = true\n",
            "no rule is named vauge-name",
        ),
        (
            "config-unknown-key",
            "[rules.vague-name]\nskp = [\"a\"]\n",
            "unknown field `skp`",
        ),
        (
            "config-other-rule",
            "[rules.vague-name]\nshare = 0.5\n",
            "share is restating-comment's to set, not vague-name's",
        ),
        (
            "config-bad-share",
            "[rules.restating-comment]\nshare = 2.0\n",
            "restating-comment's share is 2",
        ),
        ("config-syntax", "[rules.vague-name]\noff = yes\n", "line 2"),
        (
            "config-two-words",
            "[rules.vague-name]\nwords = [\"blobData\"]\n",
            "words holds \"blobData\"",
        ),
        (
            "config-only-digits",
            "[rules.vague-name]\nallow = [\"42\"]\n",
            "allow holds \"42\"",
        ),
        (
            "config-other-rule-out-of-range",
            "[rules.vague-name]\nshare = 2.0\n",
            "share is restating-comment's to set, not vague-name's",
        ),
    ] {
        let folder = folder(test);
        write(&folder, &[("orcrist.toml", config), ("load.rs", "fn load() {}\n")]);

        let output = run(&folder, &["check", "load.rs"]);

        let stderr = String::from_utf8(output.stderr.clone()).unwrap();
        assert!(
            stderr.starts_with("orcrist: ") && stderr.contains("orcrist.toml: ") && stderr.contains(says),
            "{test}: {stderr}"
        );
        assert_eq!(stdout(&output), "", "{test}");
        assert_eq!(output.status.code(), Some(2), "{test}");
    }
}

// sting: orcrist check --format json fixtures/restating.rs
#[test]
fn json_gives_each_finding_its_file_line_column_rule_and_message() {
    let output = run(
        Path::new(env!("CARGO_MANIFEST_DIR")),
        &["check", "--format", "json", "fixtures/restating.rs"],
    );

    assert_eq!(stdout(&output), RESTATING_JSON);
    assert_eq!(output.status.code(), Some(1));
}

const RESTATING_JSON: &str = r#"[
  {
    "column": 5,
    "file": "fixtures/restating.rs",
    "line": 2,
    "message": "the comment says what line 3 already says",
    "rule": "restating-comment"
  },
  {
    "column": 9,
    "file": "fixtures/restating.rs",
    "line": 5,
    "message": "tmp2 says nothing of what it is",
    "rule": "vague-name"
  },
  {
    "column": 5,
    "file": "fixtures/restating.rs",
    "line": 6,
    "message": "the error is turned into an Option and dropped",
    "rule": "swallowed-error"
  },
  {
    "column": 5,
    "file": "fixtures/restating.rs",
    "line": 7,
    "message": "what the call returns, an error among it, is bound to _ and dropped",
    "rule": "swallowed-error"
  },
  {
    "column": 5,
    "file": "fixtures/restating.rs",
    "line": 8,
    "message": "a spare says why the finding is no slop here",
    "rule": "unexplained-spare"
  },
  {
    "column": 5,
    "file": "fixtures/restating.rs",
    "line": 9,
    "message": "the error is turned into an Option and dropped",
    "rule": "swallowed-error"
  }
]
"#;

// sting: orcrist check --format sarif fixtures/configured/load.ts
#[test]
fn sarif_gives_code_scanning_the_rules_and_where_each_finding_is() {
    let output = run(
        Path::new(env!("CARGO_MANIFEST_DIR")),
        &["check", "--format", "sarif", "fixtures/configured/load.ts"],
    );

    assert_eq!(stdout(&output), CONFIGURED_SARIF);
    assert_eq!(output.status.code(), Some(1));
}

const CONFIGURED_SARIF: &str = r#"{
  "$schema": "https://json.schemastore.org/sarif-2.1.0.json",
  "runs": [
    {
      "columnKind": "unicodeCodePoints",
      "results": [
        {
          "level": "warning",
          "locations": [
            {
              "physicalLocation": {
                "artifactLocation": {
                  "uri": "fixtures/configured/load.ts"
                },
                "region": {
                  "startColumn": 1,
                  "startLine": 1
                }
              }
            }
          ],
          "message": {
            "text": "the comment says what line 2 already says"
          },
          "ruleId": "restating-comment",
          "ruleIndex": 0
        }
      ],
      "tool": {
        "driver": {
          "name": "orcrist",
          "rules": [
            {
              "id": "restating-comment",
              "shortDescription": {
                "text": "A comment most of whose words are in the line of code below it"
              }
            },
            {
              "id": "swallowed-error",
              "shortDescription": {
                "text": "An error dropped where someone needed to know of it"
              }
            },
            {
              "id": "vague-name",
              "shortDescription": {
                "text": "A name every word of which could name anything"
              }
            },
            {
              "id": "impossible-guard",
              "shortDescription": {
                "text": "A check on a parameter that its own annotation decides"
              }
            },
            {
              "id": "single-use-abstraction",
              "shortDescription": {
                "text": "An interface one type implements, or a parameter every call passes the same literal for"
              }
            },
            {
              "id": "duplicate-helper",
              "shortDescription": {
                "text": "A function that does what another of the project already does"
              }
            },
            {
              "id": "unexplained-spare",
              "shortDescription": {
                "text": "A spare that does not say why"
              }
            }
          ],
          "version": "0.1.0"
        }
      }
    }
  ],
  "version": "2.1.0"
}
"#;

#[test]
fn a_column_counts_characters_and_a_uri_escapes_what_a_path_may_not_hold() {
    let folder = folder("columns");
    write(&folder, &[("café/a b.rs", "fn été() { let data = 1; }\n")]);

    let output = run(&folder, &["check", "--format", "sarif", "café/a b.rs"]);
    let absolute = run(
        &folder,
        &[
            "check",
            "--format",
            "sarif",
            folder.join("café/a b.rs").to_str().unwrap(),
        ],
    );

    let sarif = stdout(&output);
    assert!(sarif.contains("\"uri\": \"caf%C3%A9/a%20b.rs\""), "{sarif}");
    assert!(sarif.contains("\"startColumn\": 16,"), "{sarif}");
    assert_eq!(output.status.code(), Some(1));
    let absolute_sarif = stdout(&absolute);
    let absolute_uri = format!(
        "\"uri\": \"file:///{}/caf%C3%A9/a%20b.rs\"",
        &folder.to_str().unwrap()[1..]
    );
    assert!(absolute_sarif.contains(&absolute_uri), "{absolute_sarif}");
}

#[test]
fn json_and_sarif_without_a_finding_are_still_a_document() {
    let folder = folder("empty-documents");
    write(&folder, &[("clean.rs", "fn lit() -> bool {\n    true\n}\n")]);

    let json = run(&folder, &["check", "--format", "json", "clean.rs"]);
    let sarif = run(&folder, &["check", "--format", "sarif", "clean.rs"]);

    assert_eq!(stdout(&json), "[]\n");
    assert_eq!(json.status.code(), Some(0));
    assert!(stdout(&sarif).contains("\"results\": []"), "{}", stdout(&sarif));
    assert_eq!(sarif.status.code(), Some(0));
}

// sting: orcrist check fixtures/clean/cart.ts
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

#[test]
fn idiomatic_code_in_each_language_holds_no_finding() {
    for fixture in [
        "fixtures/clean/TodoList.tsx",
        "fixtures/clean/debounce.js",
        "fixtures/clean/shapes.py",
        "fixtures/clean/inventory.rs",
    ] {
        let output = run(Path::new(env!("CARGO_MANIFEST_DIR")), &["check", fixture]);

        assert_eq!(stdout(&output), "", "{fixture}");
        assert_eq!(output.status.code(), Some(0), "{fixture}");
    }
}

/// The findings orcrist keeps between runs, in the repository's git folder.
fn cache_entries(folder: &Path) -> Vec<PathBuf> {
    fs::read_dir(folder.join(".git/orcrist-cache"))
        .map(|entries| entries.map(|entry| entry.unwrap().path()).collect())
        .unwrap_or_default()
}

#[test]
fn a_file_changed_since_the_last_run_is_read_again() {
    let folder = folder("cache-changed");
    git(&folder, &["init", "--quiet"]);
    write(
        &folder,
        &[
            ("names.ts", SLUG_OF),
            ("beacons.ts", &SLUG_OF.replace("slugOf", "beaconId")),
        ],
    );

    let first = run(&folder, &["check", "beacons.ts"]);
    write(&folder, &[("names.ts", "export const realm = 'Gondor'\n")]);
    let second = run(&folder, &["check", "beacons.ts"]);

    assert_eq!(
        stdout(&first),
        "beacons.ts:1 duplicate-helper: beaconId does what slugOf in names.ts:1 already does\n"
    );
    assert!(!cache_entries(&folder).is_empty(), "the findings of names.ts were kept");
    assert_eq!(stdout(&second), "");
    assert_eq!(second.status.code(), Some(0));
}

#[test]
fn kept_findings_that_cannot_be_read_are_found_again() {
    let folder = folder("cache-unreadable");
    git(&folder, &["init", "--quiet"]);
    write(
        &folder,
        &[
            ("names.ts", SLUG_OF),
            ("beacons.ts", &SLUG_OF.replace("slugOf", "beaconId")),
        ],
    );
    run(&folder, &["check", "beacons.ts"]);
    for entry in cache_entries(&folder) {
        fs::write(entry, "not what orcrist wrote").unwrap();
    }

    let output = run(&folder, &["check", "beacons.ts"]);

    assert_eq!(
        stdout(&output),
        "beacons.ts:1 duplicate-helper: beaconId does what slugOf in names.ts:1 already does\n"
    );
    assert_eq!(output.status.code(), Some(1));
}

#[test]
fn findings_no_run_used_for_a_week_are_let_go() {
    let folder = folder("cache-pruned");
    git(&folder, &["init", "--quiet"]);
    write(&folder, &[("names.ts", SLUG_OF), ("load.rs", "fn load() {}\n")]);
    run(&folder, &["check", "load.rs"]);
    let kept = cache_entries(&folder);
    let eight_days_ago = std::time::SystemTime::now() - std::time::Duration::from_secs(8 * 24 * 60 * 60);
    for entry in &kept {
        fs::File::options()
            .write(true)
            .open(entry)
            .unwrap()
            .set_modified(eight_days_ago)
            .unwrap();
    }
    write(&folder, &[("names.ts", "export const realm = 'Gondor'\n")]);

    run(&folder, &["check", "load.rs"]);

    assert!(!kept.is_empty());
    assert!(kept.iter().all(|entry| !entry.exists()), "{kept:?}");
    assert_eq!(
        cache_entries(&folder).len(),
        1,
        "the findings of names.ts as it is now are kept"
    );
}

#[test]
fn only_what_orcrist_kept_is_let_go_and_never_through_a_link() {
    let eight_days_ago = std::time::SystemTime::now() - std::time::Duration::from_secs(8 * 24 * 60 * 60);
    let age = |path: &Path| {
        fs::File::options()
            .write(true)
            .open(path)
            .unwrap()
            .set_modified(eight_days_ago)
            .unwrap();
    };
    let linked = folder("cache-linked");
    git(&linked, &["init", "--quiet"]);
    write(
        &linked,
        &[
            ("names.ts", SLUG_OF),
            ("load.rs", "fn load() {}\n"),
            ("elsewhere/precious.txt", "mine\n"),
            ("elsewhere/0123456789abcdef.json", "{}"),
        ],
    );
    age(&linked.join("elsewhere/precious.txt"));
    age(&linked.join("elsewhere/0123456789abcdef.json"));
    std::os::unix::fs::symlink(linked.join("elsewhere"), linked.join(".git/orcrist-cache")).unwrap();
    let foreign = folder("cache-foreign");
    git(&foreign, &["init", "--quiet"]);
    write(
        &foreign,
        &[
            ("names.ts", SLUG_OF),
            ("load.rs", "fn load() {}\n"),
            (".git/orcrist-cache/precious.txt", "mine\n"),
        ],
    );
    age(&foreign.join(".git/orcrist-cache/precious.txt"));

    let through_link = run(&linked, &["check", "load.rs"]);
    let beside_foreign = run(&foreign, &["check", "load.rs"]);

    assert_eq!(through_link.status.code(), Some(0));
    assert!(linked.join("elsewhere/precious.txt").exists());
    assert!(linked.join("elsewhere/0123456789abcdef.json").exists());
    assert_eq!(
        fs::read_dir(linked.join("elsewhere")).unwrap().count(),
        2,
        "nothing was kept through the link"
    );
    assert_eq!(beside_foreign.status.code(), Some(0));
    assert!(foreign.join(".git/orcrist-cache/precious.txt").exists());
}

// sting: orcrist check fixtures/precise.ts
#[test]
fn typescript_is_judged_where_orcrist_knows_and_left_alone_where_it_guesses() {
    let output = run(Path::new(env!("CARGO_MANIFEST_DIR")), &["check", "fixtures/precise.ts"]);

    // An alias's or a generic's values are not known, and a comment after code speaks of its own line
    assert_eq!(
        stdout(&output),
        "fixtures/precise.ts:9 swallowed-error: the error is caught and nothing is done with it\n\
         fixtures/precise.ts:12 impossible-guard: the signature already says text is string\n"
    );
    assert_eq!(output.status.code(), Some(1));
}

// sting: orcrist check fixtures/precise.py
#[test]
fn python_is_judged_where_orcrist_knows_and_left_alone_where_it_guesses() {
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

// sting: orcrist check fixtures/precise.rs
#[test]
fn an_error_matched_and_left_is_swallowed() {
    let output = run(Path::new(env!("CARGO_MANIFEST_DIR")), &["check", "fixtures/precise.rs"]);

    assert_eq!(
        stdout(&output),
        "fixtures/precise.rs:2 swallowed-error: the error is matched and nothing is done with it\n"
    );
    assert_eq!(output.status.code(), Some(1));
}

#[test]
fn a_cache_folder_others_may_read_keeps_nothing() {
    use std::os::unix::fs::PermissionsExt;
    let folder = folder("cache-shared");
    git(&folder, &["init", "--quiet"]);
    write(&folder, &[("names.ts", SLUG_OF), ("load.rs", "fn load() {}\n")]);
    fs::create_dir(folder.join(".git/orcrist-cache")).unwrap();
    fs::set_permissions(folder.join(".git/orcrist-cache"), fs::Permissions::from_mode(0o755)).unwrap();
    let private = folder.join("private");
    fs::create_dir(&private).unwrap();
    git(&private, &["init", "--quiet"]);
    write(&private, &[("names.ts", SLUG_OF), ("load.rs", "fn load() {}\n")]);

    run(&folder, &["check", "load.rs"]);
    run(&private, &["check", "load.rs"]);

    assert!(
        cache_entries(&folder).is_empty(),
        "nothing is kept where others may read"
    );
    let entries = cache_entries(&private);
    assert_eq!(entries.len(), 1);
    let mode = |path: &Path| fs::metadata(path).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode(&private.join(".git/orcrist-cache")), 0o700);
    assert_eq!(mode(&entries[0]), 0o600);
}

// sting: orcrist check fixtures/Signals.vue
#[test]
fn every_script_of_a_vue_component_is_judged_where_it_stands_in_the_file() {
    let output = run(
        Path::new(env!("CARGO_MANIFEST_DIR")),
        &["check", "--format", "json", "fixtures/Signals.vue"],
    );

    // The code on the `<script>` line is judged, at its column in the file; the `<script>` in an HTML comment is none;
    // `tmp`, after the JSX, is found only where the block is read as TSX, which its `lang`, after a `>` in the quotes
    // of `generic`, says only where that `>` ends no tag
    assert_eq!(
        stdout(&output),
        r#"[
  {
    "column": 32,
    "file": "fixtures/Signals.vue",
    "line": 1,
    "message": "data says nothing of what it is",
    "rule": "vague-name"
  },
  {
    "column": 1,
    "file": "fixtures/Signals.vue",
    "line": 9,
    "message": "the comment says what line 10 already says",
    "rule": "restating-comment"
  },
  {
    "column": 7,
    "file": "fixtures/Signals.vue",
    "line": 12,
    "message": "tmp says nothing of what it is",
    "rule": "vague-name"
  }
]
"#
    );
    assert_eq!(output.status.code(), Some(1));
}

// sting: orcrist check fixtures/closures.rs
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

// sting: orcrist check fixtures/lambdas.py
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

// sting: orcrist check --root fixtures/allowing api.py
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
fn since_a_commit_the_config_is_the_one_that_commit_holds() {
    let folder = folder("config-since-base");
    git(&folder, &["init", "--quiet"]);
    write(&folder, &[("load.ts", "export const load = () => 1\n")]);
    git(&folder, &["add", "load.ts"]);
    git(&folder, &["commit", "--quiet", "-m", "start"]);
    write(
        &folder,
        &[
            ("orcrist.toml", "[rules.vague-name]\noff = true\n"),
            ("load.ts", "export const load = () => 1\nexport const data = load()\n"),
        ],
    );

    let since = run(&folder, &["check", "--since", "HEAD"]);
    let named = run(&folder, &["check", "load.ts"]);

    // The change cannot turn off the rule that judges it; the working tree's config judges a file named
    assert_eq!(
        stdout(&since),
        "load.ts:2 vague-name: data says nothing of what it is\n"
    );
    assert_eq!(since.status.code(), Some(1));
    assert_eq!(stdout(&named), "");
    assert_eq!(named.status.code(), Some(0));
}

#[test]
fn a_path_given_through_a_link_is_skipped_where_the_config_says() {
    let folder = folder("config-linked-path");
    write(
        &folder,
        &[
            ("orcrist.toml", "[rules.vague-name]\nskip = [\"app/**\"]\n"),
            ("app/load.ts", "export const data = 1\n"),
        ],
    );
    let link = folder.with_file_name(format!("{}-link", folder.file_name().unwrap().to_str().unwrap()));
    fs::remove_file(&link).ok(); // orcrist: spare swallowed-error: the first run has no link to remove
    std::os::unix::fs::symlink(&folder, &link).unwrap();

    let output = run(&folder, &["check", link.join("app/load.ts").to_str().unwrap()]);

    assert_eq!(stdout(&output), "");
    assert_eq!(output.status.code(), Some(0));
}

#[test]
fn an_allowed_word_is_read_as_a_name_s_word_its_digits_aside() {
    let folder = folder("allow-digits");
    write(
        &folder,
        &[
            ("orcrist.toml", "[rules.vague-name]\nallow = [\"Data2\"]\n"),
            ("load.ts", "export const data3 = 1\n"),
        ],
    );

    let output = run(&folder, &["check", "load.ts"]);

    assert_eq!(stdout(&output), "");
    assert_eq!(output.status.code(), Some(0));
}

#[test]
fn since_a_commit_a_config_error_names_the_file_in_that_commit() {
    let folder = folder("since-config-error");
    git(&folder, &["init", "--quiet"]);
    write(
        &folder,
        &[
            ("orcrist.toml", "[rules.vauge-name]\noff = true\n"),
            ("load.rs", "fn load() {}\n"),
        ],
    );
    git(&folder, &["add", "orcrist.toml", "load.rs"]);
    git(&folder, &["commit", "--quiet", "-m", "start"]);

    let output = run(&folder, &["check", "--since", "HEAD"]);

    let stderr = String::from_utf8(output.stderr.clone()).unwrap();
    assert!(
        stderr.starts_with("orcrist: HEAD:orcrist.toml: no rule is named vauge-name"),
        "{stderr}"
    );
    assert_eq!(output.status.code(), Some(2));
}

#[test]
fn a_filler_word_keeps_its_digits() {
    let folder = folder("filler-digits");
    write(
        &folder,
        &[
            ("orcrist.toml", "[rules.restating-comment]\nfiller = [\"v2\"]\n"),
            ("load.ts", "// v2 read config\nconst config = readConfig()\n"),
        ],
    );

    let output = run(&folder, &["check", "load.ts"]);

    // With `v2` filler, two of the two words left are in the line below
    assert_eq!(
        stdout(&output),
        "load.ts:1 restating-comment: the comment says what line 2 already says\n"
    );
    assert_eq!(output.status.code(), Some(1));
}

// sting: orcrist check --root fixtures/misconfigured load.rs
#[test]
fn a_config_entry_of_two_words_is_refused_and_named_from_the_current_folder() {
    let output = run(
        Path::new(env!("CARGO_MANIFEST_DIR")),
        &["check", "--root", "fixtures/misconfigured", "load.rs"],
    );

    assert_eq!(
        String::from_utf8(output.stderr.clone()).unwrap(),
        "orcrist: orcrist.toml: vague-name's words holds \"blobData\", where each is one word, as orcrist splits names\n"
    );
    assert_eq!(stdout(&output), "");
    assert_eq!(output.status.code(), Some(2));
}

// sting: orcrist check fixtures/Unquoted.vue
#[test]
fn an_unquoted_lang_in_a_fixture_is_read() {
    let output = run(
        Path::new(env!("CARGO_MANIFEST_DIR")),
        &["check", "fixtures/Unquoted.vue"],
    );

    assert_eq!(
        stdout(&output),
        "fixtures/Unquoted.vue:3 vague-name: tmp says nothing of what it is\n"
    );
    assert_eq!(output.status.code(), Some(1));
}

// sting: orcrist check --since no-such-commit
#[test]
fn since_a_commit_git_does_not_know_is_said_so_from_any_folder() {
    let output = run(
        Path::new(env!("CARGO_MANIFEST_DIR")),
        &["check", "--since", "no-such-commit"],
    );

    assert_eq!(
        String::from_utf8(output.stderr.clone()).unwrap(),
        "orcrist: no-such-commit is no commit git knows\n"
    );
    assert_eq!(output.status.code(), Some(2));
}

#[test]
fn since_a_commit_from_a_subfolder_the_configs_of_that_commit_are_found() {
    let folder = folder("config-since-subfolder");
    git(&folder, &["init", "--quiet"]);
    write(
        &folder,
        &[
            ("orcrist.toml", "[rules.vague-name]\nskip = [\"app/**\"]\n"),
            ("other/orcrist.toml", "[rules.vague-name]\noff = true\n"),
            ("app/load.ts", "export const load = () => 1\n"),
            ("other/load.ts", "export const load = () => 1\n"),
        ],
    );
    git(&folder, &["add", "."]);
    git(&folder, &["commit", "--quiet", "-m", "start"]);
    write(
        &folder,
        &[
            (
                "app/load.ts",
                "export const load = () => 1\nexport const data = load()\n",
            ),
            (
                "other/load.ts",
                "export const load = () => 1\nexport const data = load()\n",
            ),
        ],
    );

    let app = run(&folder.join("app"), &["check", "--since", "HEAD"]);
    let other = run(&folder.join("other"), &["check", "--since", "HEAD"]);

    // The root's config, found from `app`, skips it; `other`'s own config turns the rule off there
    assert_eq!(stdout(&app), "");
    assert_eq!(app.status.code(), Some(0), "{}", String::from_utf8_lossy(&app.stderr));
    assert_eq!(stdout(&other), "");
    assert_eq!(
        other.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&other.stderr)
    );
}

#[test]
fn since_a_commit_outside_a_repository_is_said_to_need_one() {
    let folder = folder("since-outside");
    write(&folder, &[("load.rs", "fn load() {}\n")]);

    let since = run(&folder, &["check", "--since", "HEAD"]);

    assert_eq!(
        String::from_utf8(since.stderr.clone()).unwrap(),
        "orcrist: --since judges a change in a git repository, and this folder is in none\n"
    );
    assert_eq!(since.status.code(), Some(2));
}
