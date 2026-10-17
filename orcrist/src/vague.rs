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
    if names_an_element(name, text, source, language) {
        return None;
    }
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

/// Whether `name` is a parameter of a function passed to a method of a collection whose name says what `name` is one
/// of: `item` in `items.map((item) => …)`, `todo` in `this.todos.filter((todo) => …)`. Matched on TypeScript's and
/// JavaScript's trees alone: Rust's and Python's calls hold what they call and what they pass in other fields.
fn names_an_element(name: Node, text: &str, source: &str, language: Language) -> bool {
    let element = text.to_lowercase();
    // The parameter's name, its parameter, their list, the function: no further above
    let function = std::iter::successors(name.parent(), |node| node.parent())
        .take(3)
        .find(|node| language.syntax().function_values.contains(&node.kind()));
    let collection = function
        .and_then(|function| function.parent())
        .filter(|arguments| arguments.kind() == "arguments")
        .and_then(|arguments| arguments.parent())
        .and_then(|call| call.child_by_field_name("function"))
        .and_then(|method| method.child_by_field_name("object"))
        .and_then(|collection| words(&source[collection.byte_range()]).pop());
    collection.is_some_and(|collection| collection == format!("{element}s") || collection == format!("{element}es"))
}
