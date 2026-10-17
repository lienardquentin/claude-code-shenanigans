//! An abstraction with one user: an interface that one type implements, where the code could use that type, or a
//! parameter every caller passes the same value for.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tree_sitter::Node;

use crate::lang::Language;
use crate::project::File;
use crate::rules::{Finding, visit};

/// Calls below which a parameter every call passes one literal for is not judged: one call passes one of everything.
pub const CALLS: usize = 2;

/// What the project holds of interfaces and functions, by the language of their code and their names.
pub struct Index {
    /// Where each interface is implemented
    implementations: HashMap<(Language, String), Vec<(PathBuf, usize)>>,
    /// How many functions are named so
    definitions: HashMap<(Language, String), usize>,
    /// What each call of a function so named passes, argument by argument: the literal's text, None for other than a
    /// literal
    calls: HashMap<(Language, String), Vec<Vec<Option<String>>>>,
    /// Calls below which a parameter is not judged
    least_calls: usize,
}

/// What one file holds for the index: the interfaces it implements, the functions it defines, the calls it makes.
#[derive(Serialize, Deserialize)]
pub struct Found {
    implementations: Vec<(String, usize)>,
    definitions: Vec<String>,
    calls: Vec<(String, Vec<Option<String>>)>,
}

pub fn find(file: &File) -> Found {
    let mut found = Found {
        implementations: Vec::new(),
        definitions: Vec::new(),
        calls: Vec::new(),
    };
    visit(file.tree.root_node(), &mut |node| {
        for interface in (file.language.syntax().implemented)(node, file) {
            found
                .implementations
                .push((interface.to_string(), node.start_position().row + 1));
        }
        if let Some((name, _)) = file.function(node) {
            found.definitions.push(name.to_string());
        }
        if let Some((name, arguments)) = call(node, file) {
            found.calls.push((name.to_string(), arguments));
        }
    });
    found
}

impl Index {
    pub fn new(least_calls: usize) -> Index {
        Index {
            implementations: HashMap::new(),
            definitions: HashMap::new(),
            calls: HashMap::new(),
            least_calls,
        }
    }

    /// What one file of `language` at `path` holds, added in the order the files are.
    pub fn add(&mut self, path: &Path, language: Language, found: Found) {
        let named = |name: String| (language.code_language(), name);
        for (interface, line) in found.implementations {
            self.implementations
                .entry(named(interface))
                .or_default()
                .push((path.to_path_buf(), line));
        }
        for name in found.definitions {
            *self.definitions.entry(named(name)).or_default() += 1;
        }
        for (name, arguments) in found.calls {
            self.calls.entry(named(name)).or_default().push(arguments);
        }
    }
}

pub fn judge(node: Node, file: &File, index: &Index) -> Vec<Finding> {
    let named = |name: &str| (file.language.code_language(), name.to_string());
    let mut findings = Vec::new();
    if let Some(name) = (file.language.syntax().interface)(node, file)
        && let Some([(path, line)]) = index.implementations.get(&named(name)).map(Vec::as_slice)
    {
        let message = format!(
            "{name} has one implementation, in {}:{line}; the code could use it directly",
            path.display()
        );
        findings.push(Finding::at(node, &file.code, "single-use-abstraction", message));
    }
    if let Some((name, parameters)) = file.function(node)
        && index.definitions.get(&named(name)) == Some(&1)
        && let Some(calls) = index
            .calls
            .get(&named(name))
            .filter(|calls| calls.len() >= index.least_calls)
    {
        for (position, parameter) in parameters.iter().enumerate() {
            let passed = |call: &Vec<Option<String>>| call.get(position).cloned().flatten();
            let Some(value) = passed(&calls[0]) else { continue };
            if calls.iter().all(|call| passed(call).as_ref() == Some(&value)) {
                let message = format!("every call passes {value} for {}", &file.code[parameter.byte_range()]);
                findings.push(Finding::at(*parameter, &file.code, "single-use-abstraction", message));
            }
        }
    }
    findings
}

/// The name of the function `node` calls, and what it passes it: `light(a)`, `beacons.light(a)`, `chain::light(a)`.
fn call<'a>(node: Node, file: &'a File) -> Option<(&'a str, Vec<Option<String>>)> {
    let syntax = file.language.syntax();
    if !syntax.calls.contains(&node.kind()) {
        return None;
    }
    let function = node.child_by_field_name("function")?;
    let name = ["name", "field", "attribute", "property"]
        .iter()
        .find_map(|field| function.child_by_field_name(field))
        .unwrap_or(function);
    if !matches!(name.kind(), "identifier" | "field_identifier" | "property_identifier") {
        return None;
    }
    let arguments = node.child_by_field_name("arguments")?;
    let mut cursor = arguments.walk();
    let passed = arguments
        .named_children(&mut cursor)
        .filter(|argument| argument.kind() != "comment")
        .map(|argument| {
            syntax
                .literals
                .contains(&argument.kind())
                .then(|| file.code[argument.byte_range()].to_string())
        })
        .collect();
    Some((&file.code[name.byte_range()], passed))
}

/// The name a node gives itself, when `declares`.
fn named<'a>(node: Node, file: &'a File, declares: bool) -> Option<&'a str> {
    let name = node.child_by_field_name("name").filter(|_| declares)?;
    Some(&file.code[name.byte_range()])
}

/// `trait Store`
pub fn rust_interface<'a>(node: Node, file: &'a File) -> Option<&'a str> {
    named(node, file, node.kind() == "trait_item")
}

/// `impl Store for Disk`
pub fn rust_implemented<'a>(node: Node, file: &'a File) -> Vec<&'a str> {
    if node.kind() != "impl_item" {
        return Vec::new();
    }
    node.child_by_field_name("trait")
        .map(|interface| last_segment(&file.code[interface.byte_range()]))
        .into_iter()
        .collect()
}

/// `class Store(ABC)`
pub fn python_interface<'a>(node: Node, file: &'a File) -> Option<&'a str> {
    let declares = node.kind() == "class_definition" && python_bases(node, file).any(|supertype| supertype == "ABC");
    named(node, file, declares)
}

/// `class Disk(Store)`
pub fn python_implemented<'a>(node: Node, file: &'a File) -> Vec<&'a str> {
    if node.kind() != "class_definition" {
        return Vec::new();
    }
    python_bases(node, file).collect()
}

/// `interface Store`, `abstract class Clock`
pub fn typescript_interface<'a>(node: Node, file: &'a File) -> Option<&'a str> {
    let declares = matches!(node.kind(), "interface_declaration" | "abstract_class_declaration");
    named(node, file, declares)
}

/// `class Disk implements Store`, `class Wall extends Clock`
pub fn typescript_implemented<'a>(node: Node, file: &'a File) -> Vec<&'a str> {
    if !matches!(node.kind(), "class_declaration" | "abstract_class_declaration") {
        return Vec::new();
    }
    let mut cursor = node.walk();
    node.children(&mut cursor)
        .filter(|child| child.kind() == "class_heritage")
        .flat_map(|heritage| {
            let mut cursor = heritage.walk();
            heritage.named_children(&mut cursor).collect::<Vec<_>>()
        })
        .flat_map(|clause| {
            let mut cursor = clause.walk();
            clause.named_children(&mut cursor).collect::<Vec<_>>()
        })
        .map(|supertype| last_segment(&file.code[supertype.byte_range()]))
        .collect()
}

/// A Python class's bases, its keyword arguments such as `metaclass=` left out.
fn python_bases<'a>(class: Node, file: &'a File) -> impl Iterator<Item = &'a str> {
    let listed: Vec<Node> = class
        .child_by_field_name("superclasses")
        .map(|bases| {
            let mut cursor = bases.walk();
            bases
                .named_children(&mut cursor)
                .filter(|base| base.kind() != "keyword_argument")
                .collect()
        })
        .unwrap_or_default();
    listed
        .into_iter()
        .map(|supertype| last_segment(&file.code[supertype.byte_range()]))
}

/// `Store` of `crate::store::Store<T>`, `abc.ABC` or `ports.Store`
fn last_segment(path: &str) -> &str {
    let path = path.split_once('<').map_or(path, |(path, _)| path);
    path.rsplit_once(['.', ':']).map_or(path, |(_, last)| last).trim()
}
