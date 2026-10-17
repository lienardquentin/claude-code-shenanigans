//! A name that says nothing of what it is: every word of it could name anything.

use tree_sitter::Node;

use crate::lang::{Declared, Language, declared};
use crate::rules::Finding;
use crate::words::words;

/// Words that name anything at all, and so nothing.
#[rustfmt::skip]
const VAGUE: &[&str] = &[
    "data", "info", "information", "item", "obj", "object", "thing", "stuff", "temp", "tmp", "val", "res", "ret",
    "manager", "helper", "util", "utils", "misc", "foo", "bar", "baz",
];

/// Words that say a function does something, but not what: a variable may be a process or a handle and be clear.
const VAGUE_VERBS: &[&str] = &["process", "handle", "manage", "do", "perform"];

pub fn judge(name: Node, source: &str, language: Language) -> Option<Finding> {
    if !matches!(name.kind(), "identifier" | "property_identifier") {
        return None;
    }
    let declared = declared(name, language)?;
    let text = &source[name.byte_range()];
    vague(text, declared).then(|| Finding {
        line: name.start_position().row + 1,
        rule: "vague-name",
        message: format!("{text} says nothing of what it is"),
    })
}

fn vague(name: &str, declared: Declared) -> bool {
    let words = words(name);
    let is_vague = |word: &String| {
        let word = word.trim_end_matches(|character: char| character.is_ascii_digit());
        VAGUE.contains(&word) || (matches!(declared, Declared::Function) && VAGUE_VERBS.contains(&word))
    };
    !words.is_empty() && words.iter().all(is_vague)
}
