//! A name that says nothing of what it is: every word of it could name anything.

use tree_sitter::Node;

use crate::lang::Language;
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

enum Declared {
    Function,
    Value,
}

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

/// What `name` names, when it is where a function, a variable or a parameter is named rather than where one is used.
fn declared(name: Node, language: Language) -> Option<Declared> {
    let parent = name.parent()?;
    let is = |field| {
        parent
            .child_by_field_name(field)
            .is_some_and(|child| child.id() == name.id())
    };
    let value_is_function = || {
        parent
            .child_by_field_name("value")
            .is_some_and(|value| matches!(value.kind(), "arrow_function" | "function_expression"))
    };
    let declares = match (language, parent.kind()) {
        (Language::Rust, "function_item") => return is("name").then_some(Declared::Function),
        (Language::Rust, "let_declaration" | "parameter") => is("pattern"),
        (Language::Python, "function_definition") => return is("name").then_some(Declared::Function),
        (Language::Python, "default_parameter" | "typed_default_parameter") => is("name"),
        (Language::Python, "assignment") => is("left"),
        (Language::Python, "parameters") => true,
        // `info: str`, the name its first child
        (Language::Python, "typed_parameter") => name.prev_sibling().is_none(),
        (Language::TypeScript | Language::Vue, "function_declaration" | "method_definition") => {
            return is("name").then_some(Declared::Function);
        }
        (Language::TypeScript | Language::Vue, "variable_declarator") if value_is_function() => {
            return is("name").then_some(Declared::Function);
        }
        (Language::TypeScript | Language::Vue, "variable_declarator") => is("name"),
        (Language::TypeScript | Language::Vue, "required_parameter" | "optional_parameter") => is("pattern"),
        _ => false,
    };
    declares.then_some(Declared::Value)
}

fn vague(name: &str, declared: Declared) -> bool {
    let words = words(name);
    let is_vague = |word: &String| {
        let word = word.trim_end_matches(|character: char| character.is_ascii_digit());
        VAGUE.contains(&word) || (matches!(declared, Declared::Function) && VAGUE_VERBS.contains(&word))
    };
    !words.is_empty() && words.iter().all(is_vague)
}
