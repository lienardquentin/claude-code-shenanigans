//! A comment that says nothing its line of code does not already say.

use tree_sitter::Node;

use crate::config::Settings;
use crate::lang::{self, Language};
use crate::rules::Finding;
use crate::words::words;

/// Words a comment is made of that carry no meaning of their own.
const FILLER: &[&str] = &[
    "the", "a", "an", "of", "to", "and", "for", "from", "in", "on", "with", "this", "it", "is",
];

/// Share of a comment's meaningful words that, found in the code below, make the comment a restatement.
pub const RESTATED_SHARE: f64 = 0.75;

pub fn judge(node: Node, source: &str, language: Language, settings: &Settings) -> Option<Finding> {
    if !language.is_comment(node) {
        return None;
    }
    // A comment after code on its own line speaks of that line, not of the one below it
    let comment_line_start = node.start_byte() - node.start_position().column;
    if !source[comment_line_start..node.start_byte()].trim().is_empty() {
        return None;
    }
    let code = std::iter::successors(node.next_named_sibling(), |sibling| sibling.next_named_sibling())
        .find(|sibling| !language.is_comment(*sibling))?;
    let code_row = code.start_position().row;
    let comment = lang::comment_text(&source[node.byte_range()]);
    // The line the code starts on, from its first byte back to the line's start and on to its end
    let line_start = code.start_byte() - code.start_position().column;
    let rest = &source[line_start..];
    let code_line = &rest[..rest.find('\n').unwrap_or(rest.len())];
    restates(comment, code_line, settings).then(|| {
        let message = format!("the comment says what line {} already says", code_row + 1);
        Finding::at(node, source, "restating-comment", message)
    })
}

fn restates(comment: &str, code: &str, settings: &Settings) -> bool {
    let said: Vec<String> = words(comment)
        .into_iter()
        .filter(|word| !FILLER.contains(&word.as_str()) && !settings.filler.contains(word))
        .collect();
    if said.len() < 2 {
        return false;
    }
    let in_code = words(code);
    let restated = said.iter().filter(|word| in_code.contains(word)).count();
    restated as f64 / said.len() as f64 >= settings.restated_share
}
