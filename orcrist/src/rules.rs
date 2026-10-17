//! Every rule run over one source, parsed once.

use tree_sitter::{Node, Parser};

use crate::lang::{self, Language};
use crate::{restating, swallowed, vague};

/// Lines are counted from 1, as an editor shows them.
pub struct Finding {
    pub line: usize,
    pub rule: &'static str,
    pub message: String,
}

/// The findings in `source`, in the order of their lines.
pub fn check(source: &str, language: Language) -> Vec<Finding> {
    let code = language.code(source);
    let source = code.as_ref();
    let mut parser = Parser::new();
    parser
        .set_language(&language.grammar())
        .expect("every grammar matches tree-sitter's version");
    let tree = parser
        .parse(source, None)
        .expect("a parser with a language set always parses");
    let mut findings = Vec::new();
    let mut spares = Vec::new();
    visit(tree.root_node(), &mut |node| {
        findings.extend(restating::judge(node, source, language));
        findings.extend(swallowed::judge(node, source, language));
        findings.extend(vague::judge(node, source, language));
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

fn visit(node: Node, on_node: &mut impl FnMut(Node)) {
    on_node(node);
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        visit(child, on_node);
    }
}
