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
    let folder = folder("one-subclass");
    fs::write(
        folder.join("store.py"),
        "class Store(ABC):\n    @abstractmethod\n    def save(self, text: str) -> None: ...\n\n\nclass Disk(Store):\n    def save(self, text: str) -> None:\n        write(text)\n\n\nclass Clock(abc.ABC):\n    pass\n\n\nclass Wall(Clock):\n    pass\n\n\nclass Sun(Clock):\n    pass\n",
    )
    .unwrap();

    let output = run(&folder, &["check", "store.py"]);

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
