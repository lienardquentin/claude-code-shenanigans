//! An abstraction with one user: an interface that one type implements, where the code could use that type, or a
//! parameter every caller passes the same value for.

use std::collections::HashMap;
use std::path::PathBuf;

use tree_sitter::Node;

use crate::lang::Language;
use crate::parallel;
use crate::project::{File, Project};
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

impl Index {
    pub fn build(project: &Project, least_calls: usize) -> Index {
        let mut index = Index {
            implementations: HashMap::new(),
            definitions: HashMap::new(),
            calls: HashMap::new(),
            least_calls,
        };
        let found = parallel::map(&project.files, |file| {
            let (mut implementations, mut definitions, mut calls) = (Vec::new(), Vec::new(), Vec::new());
            visit(file.tree.root_node(), &mut |node| {
                for interface in implemented(node, file) {
                    implementations.push((interface, node.start_position().row + 1));
                }
                if let Some((name, _)) = file.function(node) {
                    definitions.push(name);
                }
                calls.extend(call(node, file));
            });
            (implementations, definitions, calls)
        });
        for (file, (implementations, definitions, calls)) in project.files.iter().zip(found) {
            let named = |name: &str| (file.language.code_language(), name.to_string());
            for (interface, line) in implementations {
                index
                    .implementations
                    .entry(named(interface))
                    .or_default()
                    .push((file.path.clone(), line));
            }
            for name in definitions {
                *index.definitions.entry(named(name)).or_default() += 1;
            }
            for (name, arguments) in calls {
                index.calls.entry(named(name)).or_default().push(arguments);
            }
        }
        index
    }
}

pub fn judge(node: Node, file: &File, index: &Index) -> Vec<Finding> {
    let named = |name: &str| (file.language.code_language(), name.to_string());
    let mut findings = Vec::new();
    if let Some(name) = interface(node, file)
        && let Some([(path, line)]) = index.implementations.get(&named(name)).map(Vec::as_slice)
    {
        findings.push(Finding {
            line: node.start_position().row + 1,
            rule: "single-use-abstraction",
            message: format!(
                "{name} has one implementation, in {}:{line}; the code could use it directly",
                path.display()
            ),
        });
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
                findings.push(Finding {
                    line: parameter.start_position().row + 1,
                    rule: "single-use-abstraction",
                    message: format!("every call passes {value} for {}", &file.code[parameter.byte_range()]),
                });
            }
        }
    }
    findings
}

/// The name of the function `node` calls, and what it passes it: `light(a)`, `beacons.light(a)`, `chain::light(a)`.
fn call<'a>(node: Node, file: &'a File) -> Option<(&'a str, Vec<Option<String>>)> {
    let literals: &[&str] = match (file.language, node.kind()) {
        (Language::Rust, "call_expression") => &[
            "integer_literal",
            "float_literal",
            "string_literal",
            "boolean_literal",
            "char_literal",
        ],
        (Language::Python, "call") => &["integer", "float", "string", "true", "false", "none"],
        (Language::TypeScript | Language::Jsx | Language::Vue, "call_expression") => {
            &["number", "string", "true", "false", "null", "undefined"]
        }
        _ => return None,
    };
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
            literals
                .contains(&argument.kind())
                .then(|| file.code[argument.byte_range()].to_string())
        })
        .collect();
    Some((&file.code[name.byte_range()], passed))
}

/// The name of the interface `node` declares: a trait, an abstract class, a TypeScript interface.
fn interface<'a>(node: Node, file: &'a File) -> Option<&'a str> {
    let declares = match (file.language, node.kind()) {
        (Language::Rust, "trait_item") => true,
        (Language::Python, "class_definition") => supertypes(node, file).any(|supertype| supertype == "ABC"),
        (
            Language::TypeScript | Language::Jsx | Language::Vue,
            "interface_declaration" | "abstract_class_declaration",
        ) => true,
        _ => false,
    };
    let name = node.child_by_field_name("name").filter(|_| declares)?;
    Some(&file.code[name.byte_range()])
}

/// The names of the interfaces `node` implements: `impl Store for Disk`, `class Disk(Store)`,
/// `class Disk implements Store`, `class Wall extends Clock`.
fn implemented<'a>(node: Node, file: &'a File) -> Vec<&'a str> {
    match (file.language, node.kind()) {
        (Language::Rust, "impl_item") => node
            .child_by_field_name("trait")
            .map(|interface| last_segment(&file.code[interface.byte_range()]))
            .into_iter()
            .collect(),
        (Language::Python, "class_definition")
        | (Language::TypeScript | Language::Jsx | Language::Vue, "class_declaration" | "abstract_class_declaration") => {
            supertypes(node, file).collect()
        }
        _ => Vec::new(),
    }
}

/// What a class names after its own name: its bases in Python, what it extends and implements in TypeScript.
fn supertypes<'a>(class: Node, file: &'a File) -> impl Iterator<Item = &'a str> {
    let mut cursor = class.walk();
    let listed: Vec<Node> = match file.language {
        Language::Python => class
            .child_by_field_name("superclasses")
            .map(|bases| {
                let mut cursor = bases.walk();
                bases
                    .named_children(&mut cursor)
                    .filter(|base| base.kind() != "keyword_argument")
                    .collect()
            })
            .unwrap_or_default(),
        _ => class
            .children(&mut cursor)
            .filter(|child| child.kind() == "class_heritage")
            .flat_map(|heritage| {
                let mut cursor = heritage.walk();
                heritage.named_children(&mut cursor).collect::<Vec<_>>()
            })
            .flat_map(|clause| {
                let mut cursor = clause.walk();
                clause.named_children(&mut cursor).collect::<Vec<_>>()
            })
            .collect(),
    };
    listed
        .into_iter()
        .map(|supertype| last_segment(&file.code[supertype.byte_range()]))
}

/// `Store` of `crate::store::Store<T>`, `abc.ABC` or `ports.Store`
fn last_segment(path: &str) -> &str {
    let path = path.split_once('<').map_or(path, |(path, _)| path);
    path.rsplit_once(['.', ':']).map_or(path, |(_, last)| last).trim()
}
