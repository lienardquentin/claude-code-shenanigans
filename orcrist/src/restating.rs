//! A comment that says nothing its line of code does not already say.

use tree_sitter::Node;

use crate::rules::Finding;

/// Words a comment is made of that carry no meaning of their own.
const FILLER: &[&str] = &[
    "the", "a", "an", "of", "to", "and", "for", "from", "in", "on", "with", "this", "it", "is",
];

/// Share of a comment's meaningful words that, found in the code below, make the comment a restatement.
const RESTATED_SHARE: f64 = 0.75;

pub fn judge(node: Node, source: &str) -> Option<Finding> {
    if node.kind() != "line_comment" {
        return None;
    }
    let code = node.next_named_sibling()?;
    let code_row = code.start_position().row;
    let comment = source[node.byte_range()].trim_start_matches('/');
    let code_line = source.lines().nth(code_row)?;
    restates(comment, code_line).then(|| Finding {
        line: node.start_position().row + 1,
        rule: "restating-comment",
        message: format!("the comment says what line {} already says", code_row + 1),
    })
}

fn restates(comment: &str, code: &str) -> bool {
    let said: Vec<String> = words(comment)
        .into_iter()
        .filter(|word| !FILLER.contains(&word.as_str()))
        .collect();
    if said.len() < 2 {
        return false;
    }
    let in_code = words(code);
    let restated = said.iter().filter(|word| in_code.contains(word)).count();
    restated as f64 / said.len() as f64 >= RESTATED_SHARE
}

/// Lowercase words, identifiers split at underscores and at camelCase humps.
fn words(text: &str) -> Vec<String> {
    let mut words = Vec::new();
    let mut word = String::new();
    let mut previous_lower = false;
    for character in text.chars() {
        let breaks = !character.is_alphanumeric() || (character.is_uppercase() && previous_lower);
        if breaks && !word.is_empty() {
            words.push(std::mem::take(&mut word));
        }
        if character.is_alphanumeric() {
            word.extend(character.to_lowercase());
        }
        previous_lower = character.is_lowercase();
    }
    if !word.is_empty() {
        words.push(word);
    }
    words
}
