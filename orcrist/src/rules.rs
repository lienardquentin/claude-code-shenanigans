//! Every rule run over one file of the project.

use tree_sitter::Node;

use crate::config::Settings;
use crate::lang::{self, Language};
use crate::project::{File, Project};
use crate::{duplicate, impossible, restating, single_use, swallowed, vague};

/// Every rule a finding can come from, as the config and the findings name them, and what it finds.
pub const RULES: [(&str, &str); 7] = [
    (
        "restating-comment",
        "A comment most of whose words are in the line of code below it",
    ),
    ("swallowed-error", "An error dropped where someone needed to know of it"),
    ("vague-name", "A name every word of which could name anything"),
    (
        "impossible-guard",
        "A check on a parameter that its own annotation decides",
    ),
    (
        "single-use-abstraction",
        "An interface one type implements, or a parameter every call passes the same literal for",
    ),
    (
        "duplicate-helper",
        "A function that does what another of the project already does",
    ),
    ("unexplained-spare", "A spare that does not say why"),
];

/// Lines and columns are counted from 1, as an editor shows them, a column in characters.
pub struct Finding {
    pub line: usize,
    pub column: usize,
    pub rule: &'static str,
    pub message: String,
}

impl Finding {
    /// A finding where `node` starts in `source`.
    pub fn at(node: Node, source: &str, rule: &'static str, message: String) -> Finding {
        let (line, column) = position(node, source);
        Finding {
            line,
            column,
            rule,
            message,
        }
    }
}

/// The line and column `node` starts at, each counted from 1, the column in characters where tree-sitter counts bytes.
fn position(node: Node, source: &str) -> (usize, usize) {
    let start = node.start_position();
    let line_start = node.start_byte() - start.column;
    (start.row + 1, source[line_start..node.start_byte()].chars().count() + 1)
}

/// What the rules that look across files know of the whole project, gathered once.
pub struct Indexes {
    single_use: single_use::Index,
    duplicate: duplicate::Index,
}

pub fn index(project: &Project, settings: &Settings) -> Indexes {
    Indexes {
        single_use: single_use::Index::build(project, settings.calls),
        duplicate: duplicate::Index::build(project, settings.smallest),
    }
}

/// The findings in `file`, in the order of their lines.
pub fn check(file: &File, indexes: &Indexes, settings: &Settings) -> Vec<Finding> {
    let (source, language) = (file.code.as_str(), file.language);
    let mut findings = Vec::new();
    let mut spares = Vec::new();
    visit(file.tree.root_node(), &mut |node| {
        findings.extend(restating::judge(node, source, language, settings));
        findings.extend(swallowed::judge(node, source, language));
        findings.extend(vague::judge(node, source, language, settings));
        findings.extend(impossible::judge(node, source, language));
        findings.extend(single_use::judge(node, file, &indexes.single_use));
        findings.extend(duplicate::judge(node, file, &indexes.duplicate));
        spares.extend(spare(node, source, language));
    });
    // A spare covers the finding on its own line and on the line below it
    findings.retain(|finding| {
        !spares.iter().any(|spare| {
            spare.explained
                && spare.rule == finding.rule
                && (spare.line == finding.line || spare.line + 1 == finding.line)
        })
    });
    for spare in spares.iter().filter(|spare| !spare.explained) {
        findings.push(Finding {
            line: spare.line,
            column: spare.column,
            rule: "unexplained-spare",
            message: "a spare says why the finding is no slop here".to_string(),
        });
    }
    findings.sort_by_key(|finding| finding.line);
    findings
}

struct Spare<'a> {
    line: usize,
    column: usize,
    rule: &'a str,
    explained: bool,
}

/// What a comment spares, as in `// orcrist: spare swallowed-error: why it is no slop here`.
fn spare<'a>(node: Node, source: &'a str, language: Language) -> Option<Spare<'a>> {
    if !language.is_comment(node) {
        return None;
    }
    let (_, spare) = lang::comment_text(&source[node.byte_range()]).split_once("orcrist: spare ")?;
    let (rule, reason) = spare.split_once(':').unwrap_or((spare, ""));
    let (line, column) = position(node, source);
    Some(Spare {
        line,
        column,
        rule: rule.trim(),
        explained: !reason.trim().is_empty(),
    })
}

pub fn visit<'a>(node: Node<'a>, on_node: &mut impl FnMut(Node<'a>)) {
    on_node(node);
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        visit(child, on_node);
    }
}
