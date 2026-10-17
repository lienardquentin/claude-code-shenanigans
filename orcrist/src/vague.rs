//! A name that says nothing of what it is: every word of it could name anything.

use tree_sitter::Node;

use crate::config::Settings;
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

pub fn judge(name: Node, source: &str, language: Language, settings: &Settings) -> Option<Finding> {
    if !matches!(name.kind(), "identifier" | "property_identifier") {
        return None;
    }
    let declared = declared(name, language)?;
    let text = &source[name.byte_range()];
    vague(text, declared, settings)
        .then(|| Finding::at(name, source, "vague-name", format!("{text} says nothing of what it is")))
}

fn vague(name: &str, declared: Declared, settings: &Settings) -> bool {
    let words = words(name);
    let is_vague = |word: &String| {
        let word = word.trim_end_matches(|character: char| character.is_ascii_digit());
        let vague_verb = VAGUE_VERBS.contains(&word) || settings.vague_verbs.iter().any(|verb| verb == word);
        VAGUE.contains(&word)
            || settings.vague_words.iter().any(|vague| vague == word)
            || (matches!(declared, Declared::Function) && vague_verb)
    };
    !words.is_empty() && words.iter().all(is_vague)
}
