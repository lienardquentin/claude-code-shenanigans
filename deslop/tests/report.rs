//! The formats the findings are written in.

mod common;

use std::fs;
use std::path::Path;
use std::process::Command;

use common::{folder, run, stdout, write};

// pins: deslop check --format json fixtures/restating.rs
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

// pins: deslop check --format sarif fixtures/configured/load.ts
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
          "name": "deslop",
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
    assert_eq!(absolute.status.code(), Some(1));
    let absolute_sarif = stdout(&absolute);
    let escaped_folder: Vec<String> = folder
        .components()
        .filter(|part| !matches!(part, std::path::Component::RootDir))
        .map(|part| percent_encoded(part.as_os_str().to_str().unwrap()))
        .collect();
    let absolute_uri = format!("\"uri\": \"file:///{}/caf%C3%A9/a%20b.rs\"", escaped_folder.join("/"));
    assert!(absolute_sarif.contains(&absolute_uri), "{absolute_sarif}");
}

/// A part of a path with every byte but the unreserved ones written `%XX`.
fn percent_encoded(part: &str) -> String {
    part.bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | 126 => (byte as char).to_string(),
            _ => format!("%{byte:02X}"),
        })
        .collect()
}

#[cfg(target_os = "linux")]
#[test]
fn a_uri_keeps_the_bytes_of_a_name_that_is_not_utf8() {
    use std::ffi::OsStr;
    use std::os::unix::ffi::OsStrExt;

    let folder = folder("non-utf8-name");
    let name = OsStr::from_bytes(b"a\xFFb.rs");
    fs::write(folder.join(name), "fn lit() { let data = 1; }\n").unwrap();

    let output = Command::new(env!("CARGO_BIN_EXE_deslop"))
        .args(["check", "--format", "sarif"])
        .arg(name)
        .current_dir(&folder)
        .output()
        .unwrap();

    let sarif = stdout(&output);
    assert!(sarif.contains("a%FFb.rs"), "{sarif}");
    assert!(!sarif.contains("%EF%BF%BD"), "{sarif}");
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
