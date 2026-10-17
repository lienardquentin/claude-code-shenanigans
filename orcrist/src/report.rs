//! How the findings are written: as lines a person reads, as JSON, or as SARIF for code scanning.

use std::path::{Component, PathBuf};

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
/// between its parts and every byte but the ones a URI path may hold as they are written `%XX`, as in
/// `caf%C3%A9/a%20b.rs`.
fn uri(path: &std::path::Path) -> String {
    let parts: Vec<String> = path
        .components()
        // The root is the `file:///` below, and a drive is no part of a URI path
        .filter(|part| !matches!(part, Component::RootDir | Component::Prefix(_)))
        .map(|part| {
            part.as_os_str()
                .to_string_lossy()
                .bytes()
                .map(|byte| match byte {
                    b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => (byte as char).to_string(),
                    _ => format!("%{byte:02X}"),
                })
                .collect()
        })
        .collect();
    let relative = parts.join("/");
    if path.is_absolute() {
        format!("file:///{relative}")
    } else {
        relative
    }
}

fn pretty(value: &Value) -> String {
    let mut written = serde_json::to_string_pretty(value).expect("a JSON value is always written");
    written.push('\n');
    written
}
