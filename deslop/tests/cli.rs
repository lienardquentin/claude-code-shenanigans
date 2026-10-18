//! The command line as a person runs it: `--since`, the files given, the languages read, and what is refused.

mod common;

use std::fs;
use std::path::Path;

use common::{check, folder, git, run, stdout, write};

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
fn since_a_commit_what_deslop_cannot_read_is_named_and_jsx_is_read() {
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
        "deslop: left unjudged, of no language deslop reads: 1 .md, 1 Makefile\n"
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
            .starts_with("deslop: left out of the project: cannot read bundle.js: "),
        "{output:?}"
    );
    assert_eq!(output.status.code(), Some(1));
}

#[test]
fn since_is_only_ever_a_commit_to_git() {
    let folder = folder("since-option");
    git(&folder, &["init", "--quiet"]);

    let output = run(&folder, &["check", "--since=--output=written"]);

    // Refused as no commit before any git command could take it for an option, as `--output=written:deslop.toml`
    let written: Vec<_> = fs::read_dir(&folder)
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .filter(|name| name.to_string_lossy().starts_with("written"))
        .collect();
    assert!(written.is_empty(), "git took the commit for an option: {written:?}");
    assert_eq!(output.status.code(), Some(2));
}

#[test]
fn a_file_of_a_language_deslop_does_not_read_is_refused() {
    let output = check(
        "unknown-language",
        "notes.txt",
        "// read the config file\nread_config_file()\n",
    );

    assert_eq!(
        String::from_utf8(output.stderr.clone()).unwrap(),
        "deslop: no language deslop reads has the extension of notes.txt\n"
    );
    assert_eq!(stdout(&output), "");
    assert_eq!(output.status.code(), Some(2));
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

// pins: deslop check fixtures/Beacons.tsx
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

// pins: deslop check fixtures/light.js
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

// pins: deslop check fixtures/Signals.vue
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

// pins: deslop check fixtures/Unquoted.vue
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

// pins: deslop check --since no-such-commit
#[test]
fn since_a_commit_git_does_not_know_is_said_so_from_any_folder() {
    let output = run(
        Path::new(env!("CARGO_MANIFEST_DIR")),
        &["check", "--since", "no-such-commit"],
    );

    assert_eq!(
        String::from_utf8(output.stderr.clone()).unwrap(),
        "deslop: no-such-commit is no commit git knows\n"
    );
    assert_eq!(output.status.code(), Some(2));
}

#[test]
fn since_a_commit_outside_a_repository_is_said_to_need_one() {
    let folder = folder("since-outside");
    write(&folder, &[("load.rs", "fn load() {}\n")]);

    let since = run(&folder, &["check", "--since", "HEAD"]);

    assert_eq!(
        String::from_utf8(since.stderr.clone()).unwrap(),
        "deslop: --since judges a change in a git repository, and this folder is in none\n"
    );
    assert_eq!(since.status.code(), Some(2));
}
