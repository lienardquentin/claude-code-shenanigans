//! Every rule run over one file of the project.

use tree_sitter::Node;

use crate::lang::{self, Language};
use crate::project::{File, Project};
use crate::{impossible, restating, single_use, swallowed, vague};

/// Lines are counted from 1, as an editor shows them.
pub struct Finding {
    pub line: usize,
    pub rule: &'static str,
    pub message: String,
}

/// What the rules that look across files know of the whole project, gathered once.
pub struct Indexes {
    single_use: single_use::Index,
}

pub fn index(project: &Project) -> Indexes {
    Indexes {
        single_use: single_use::Index::build(project),
    }
}

/// The findings in `file`, in the order of their lines.
pub fn check(file: &File, indexes: &Indexes) -> Vec<Finding> {
    let (source, language) = (file.code.as_str(), file.language);
    let mut findings = Vec::new();
    let mut spares = Vec::new();
    visit(file.tree.root_node(), &mut |node| {
        findings.extend(restating::judge(node, source, language));
        findings.extend(swallowed::judge(node, source, language));
        findings.extend(vague::judge(node, source, language));
        findings.extend(impossible::judge(node, source, language));
        findings.extend(single_use::judge(node, file, &indexes.single_use));
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
            rule: "unexplained-spare",
            message: "a spare says why the finding is no slop here".to_string(),
        });
    }
    findings.sort_by_key(|finding| finding.line);
    findings
}

struct Spare<'a> {
    line: usize,
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
    Some(Spare {
        line: node.start_position().row + 1,
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
