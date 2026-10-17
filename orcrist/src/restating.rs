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
    let code = std::iter::successors(node.next_named_sibling(), |sibling| sibling.next_named_sibling())
        .find(|sibling| !language.is_comment(*sibling))?;
    let code_row = code.start_position().row;
    let comment = lang::comment_text(&source[node.byte_range()]);
    let code_line = source.lines().nth(code_row)?;
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
