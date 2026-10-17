//! How the findings are written: as lines a person reads, as JSON, or as SARIF for code scanning.

use std::ffi::OsStr;
use std::path::{Component, Path, PathBuf, Prefix};

use clap::ValueEnum;
use serde_json::{Value, json};

use crate::rules::{Finding, RULES};

#[derive(Clone, Copy, ValueEnum)]
pub enum Format {
    /// `file:line rule: message`, one finding a line
    Text,
    /// An array of findings, each with its file, line, column, rule and message
    Json,
    /// SARIF 2.1.0, for code scanning
    Sarif,
}

/// The findings, each with the path of its file as it was given or as git listed it, written in `format`: nothing for no
/// finding as text, an empty array or run otherwise.
pub fn write(format: Format, findings: &[(PathBuf, Finding)]) -> String {
    match format {
        Format::Text => findings
            .iter()
            .map(|(path, finding)| {
                format!(
                    "{}:{} {}: {}\n",
                    path.display(),
                    finding.line,
                    finding.rule,
                    finding.message
                )
            })
            .collect(),
        Format::Json => {
            let findings: Vec<Value> = findings
                .iter()
                .map(|(path, finding)| {
                    json!({
                        "file": path.to_string_lossy(),
                        "line": finding.line,
                        "column": finding.column,
                        "rule": finding.rule,
                        "message": finding.message,
                    })
                })
                .collect();
            pretty(&Value::Array(findings))
        }
        Format::Sarif => pretty(&sarif(findings)),
    }
}

fn sarif(findings: &[(PathBuf, Finding)]) -> Value {
    let rules: Vec<Value> = RULES
        .iter()
        .map(|(name, finds)| json!({ "id": name, "shortDescription": { "text": finds } }))
        .collect();
    let results: Vec<Value> = findings
        .iter()
        .map(|(path, finding)| {
            json!({
                "ruleId": finding.rule,
                "ruleIndex": RULES.iter().position(|(name, _)| *name == finding.rule),
                "level": "warning",
                "message": { "text": finding.message },
                "locations": [{
                    "physicalLocation": {
                        "artifactLocation": { "uri": uri(path) },
                        "region": { "startLine": finding.line, "startColumn": finding.column },
                    },
                }],
            })
        })
        .collect();
    json!({
        "$schema": "https://json.schemastore.org/sarif-2.1.0.json",
        "version": "2.1.0",
        "runs": [{
            "tool": {
                "driver": {
                    "name": "orcrist",
                    "version": env!("CARGO_PKG_VERSION"),
                    "rules": rules,
                },
            },
            // A finding's column counts characters, not the UTF-16 units SARIF counts by default
            "columnKind": "unicodeCodePoints",
            "results": results,
        }],
    })
}

/// A path as a URI: relative to the current folder as it is given, or a `file:///` URI when it is absolute, with `/`
/// between its parts and every byte but the ones a URI path may hold, as the path holds them, written `%XX`, as in
/// `caf%C3%A9/a%20b.rs`. A Windows drive stays in the path (`file:///C:/a.rs`) and a UNC host goes in the authority
/// (`file://server/share/a.rs`).
fn uri(path: &Path) -> String {
    let mut authority = String::new();
    let mut parts = Vec::new();
    for part in path.components() {
        match part {
            // The root is the `file:///` below
            Component::RootDir => {}
            Component::Prefix(prefix) => match prefix.kind() {
                Prefix::Disk(letter) | Prefix::VerbatimDisk(letter) => parts.push(format!("{}:", letter as char)),
                Prefix::UNC(server, share) | Prefix::VerbatimUNC(server, share) => {
                    authority = escape(server);
                    parts.push(escape(share));
                }
                _ => {}
            },
            _ => parts.push(escape(part.as_os_str())),
        }
    }
    let relative = parts.join("/");
    if path.is_absolute() {
        format!("file://{authority}/{relative}")
    } else {
        relative
    }
}

/// The bytes of a path part as the path holds them: the ones of its OS string on unix, of its UTF-8 elsewhere, where
/// paths are UTF-16.
fn escape(part: &OsStr) -> String {
    #[cfg(unix)]
    let bytes = std::os::unix::ffi::OsStrExt::as_bytes(part).to_vec();
    #[cfg(not(unix))]
    let bytes = part.to_string_lossy().into_owned().into_bytes();
    bytes
        .iter()
        .map(|&byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => (byte as char).to_string(),
            _ => format!("%{byte:02X}"),
        })
        .collect()
}

#[cfg(all(test, windows))]
mod tests {
    use super::uri;
    use std::path::Path;

    #[test]
    fn a_drive_stays_in_the_path() {
        assert_eq!(uri(Path::new(r"C:\a b\x.rs")), "file:///C:/a%20b/x.rs");
    }

    #[test]
    fn a_unc_host_goes_in_the_authority() {
        assert_eq!(uri(Path::new(r"\\server\share\x.rs")), "file://server/share/x.rs");
    }
}

fn pretty(value: &Value) -> String {
    let mut written = serde_json::to_string_pretty(value).expect("a JSON value is always written");
    written.push('\n');
    written
}
