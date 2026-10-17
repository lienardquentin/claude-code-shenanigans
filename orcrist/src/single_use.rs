//! An abstraction with one user: an interface that one type implements, where the code could use that type, or a
//! parameter every caller passes the same value for.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tree_sitter::Node;

use crate::lang::Language;
use crate::project::File;
use crate::rules::{Finding, visit};

/// Calls below which a parameter every call passes one literal for is not judged: one call passes one of everything.
pub const CALLS: usize = 2;

/// What the project holds of interfaces and functions, by the language of their code and their names. A function is
/// counted, and gathers its calls, with the others of its name in its scope: a local in the function it is defined in,
/// a method or a free function across the project. A call through a receiver or a path may reach a method or a free
/// function, which cannot be told apart, so that a function is judged only when no call it is judged from could reach
/// another of its name.
pub struct Index {
    /// Where each interface is implemented
    implementations: HashMap<(Language, String), Vec<(PathBuf, usize)>>,
    /// How many functions of each scope are named so
    definitions: HashMap<(Language, Scope, String), usize>,
    /// What each bare call passes, by the local or free function it reaches
    calls: HashMap<(Language, Scope, String), Vec<Passed>>,
    /// What each call through a receiver or a path passes, by the name it calls
    through: HashMap<(Language, String), Vec<Passed>>,
    /// How many calls a parameter is judged from
    least_calls: usize,
}

/// What a call passes, argument by argument: the literal's text, None for other than a literal.
type Passed = Vec<Option<String>>;

/// Where in the project a function is defined, as the index keys it.
#[derive(Clone, PartialEq, Eq, Hash)]
enum Scope {
    /// In the function of this file starting at this byte
    Local(PathBuf, usize),
    Method,
    Free,
}

/// Where in its file a function is defined, which tells the calls that can reach it.
#[derive(Serialize, Deserialize)]
enum Defined {
    /// Inside the function starting at this byte: reached by the bare calls of that function
    Local(usize),
    /// In an impl, a trait, a class or an object: reached through a receiver or a path, `tower.light()`,
    /// `Disk::light()`
    Method,
    /// Anywhere else, a module's lambda or arrow function among them: reached by bare calls, and through a path or a
    /// dot as a module's function
    Free,
}

/// The function a call can reach.
#[derive(Serialize, Deserialize)]
enum Reaches {
    /// The local function its bare name resolves to, inside the function starting at this byte
    Local(usize),
    /// A free function, its name bare
    Free,
    /// A method or a free function, called through a receiver or a path
    Either,
}

/// What one file holds for the index: the interfaces it implements, the functions it defines, the calls it makes.
#[derive(Serialize, Deserialize)]
pub struct Found {
    implementations: Vec<(String, usize)>,
    definitions: Vec<(Defined, String)>,
    calls: Vec<(Reaches, String, Passed)>,
}

pub fn find(file: &File) -> Found {
    let mut found = Found {
        implementations: Vec::new(),
        definitions: Vec::new(),
        calls: Vec::new(),
    };
    let mut bare = Vec::new();
    visit(file.tree.root_node(), &mut |node| {
        for interface in (file.language.syntax().implemented)(node, file) {
            found
                .implementations
                .push((interface.to_string(), node.start_position().row + 1));
        }
        if let Some((name, _)) = file.function(node) {
            found.definitions.push((defined(node, file), name.to_string()));
        }
        match call(node, file) {
            Some((name, arguments, true)) => found.calls.push((Reaches::Either, name.to_string(), arguments)),
            Some((name, arguments, false)) => bare.push((node, name, arguments)),
            None => {}
        }
    });
    let locals: HashSet<(usize, &str)> = found
        .definitions
        .iter()
        .filter_map(|(defined, name)| match defined {
            Defined::Local(function) => Some((*function, name.as_str())),
            _ => None,
        })
        .collect();
    for (node, name, arguments) in bare {
        // The nearest function the call is in that defines a local of its name
        let reaches = functions_around(node, file)
            .find(|function| locals.contains(&(function.start_byte(), name)))
            .map_or(Reaches::Free, |function| Reaches::Local(function.start_byte()));
        found.calls.push((reaches, name.to_string(), arguments));
    }
    found
}

impl Index {
    pub fn new(least_calls: usize) -> Index {
        Index {
            implementations: HashMap::new(),
            definitions: HashMap::new(),
            calls: HashMap::new(),
            through: HashMap::new(),
            least_calls,
        }
    }

    /// What one file of `language` at `path` holds, added in the order the files are.
    pub fn add(&mut self, path: &Path, language: Language, found: Found) {
        let language = language.code_language();
        for (interface, line) in found.implementations {
            self.implementations
                .entry((language, interface))
                .or_default()
                .push((path.to_path_buf(), line));
        }
        for (defined, name) in found.definitions {
            *self
                .definitions
                .entry((language, Scope::of(defined, path), name))
                .or_default() += 1;
        }
        for (reaches, name, arguments) in found.calls {
            let scope = match reaches {
                Reaches::Local(function) => Scope::Local(path.to_path_buf(), function),
                Reaches::Free => Scope::Free,
                Reaches::Either => {
                    self.through.entry((language, name)).or_default().push(arguments);
                    continue;
                }
            };
            self.calls.entry((language, scope, name)).or_default().push(arguments);
        }
    }

    /// The calls the function `name` of `language` defined in `scope` is judged from, None where it is not judged:
    /// where another of its name shares its scope, or where a call through a receiver or a path could reach another
    /// of its name.
    fn calls_of(&self, language: Language, scope: Scope, name: &str) -> Option<Vec<&Passed>> {
        let count = |scope: Scope| {
            let key = (language, scope, name.to_string());
            self.definitions.get(&key).copied().unwrap_or(0)
        };
        let bare = |scope: Scope| {
            self.calls
                .get(&(language, scope, name.to_string()))
                .into_iter()
                .flatten()
        };
        let through = self
            .through
            .get(&(language, name.to_string()))
            .map_or(&[][..], Vec::as_slice);
        let other = match scope {
            Scope::Local(..) => None,
            Scope::Method => Some(Scope::Free),
            Scope::Free => Some(Scope::Method),
        };
        if count(scope.clone()) != 1 || (!through.is_empty() && other.is_some_and(|other| count(other) > 0)) {
            return None;
        }
        Some(match scope {
            Scope::Local(..) => bare(scope).collect(),
            Scope::Method => through.iter().collect(),
            Scope::Free => bare(scope).chain(through).collect(),
        })
    }
}

impl Scope {
    fn of(defined: Defined, path: &Path) -> Scope {
        match defined {
            Defined::Local(function) => Scope::Local(path.to_path_buf(), function),
            Defined::Method => Scope::Method,
            Defined::Free => Scope::Free,
        }
    }
}

pub fn judge(node: Node, file: &File, index: &Index) -> Vec<Finding> {
    let language = file.language.code_language();
    let mut findings = Vec::new();
    if let Some(name) = (file.language.syntax().interface)(node, file)
        && let Some([(path, line)]) = index
            .implementations
            .get(&(language, name.to_string()))
            .map(Vec::as_slice)
    {
        let message = format!(
            "{name} has one implementation, in {}:{line}; the code could use it directly",
            path.display()
        );
        findings.push(Finding::at(node, &file.code, "single-use-abstraction", message));
    }
    if let Some((name, parameters)) = file.function(node)
        && let Some(calls) = index
            .calls_of(language, Scope::of(defined(node, file), &file.path), name)
            .filter(|calls| calls.len() >= index.least_calls)
    {
        for (position, parameter) in parameters.iter().enumerate() {
            let passed = |call: &Passed| call.get(position).cloned().flatten();
            let Some(value) = passed(calls[0]) else { continue };
            if calls.iter().all(|call| passed(call).as_ref() == Some(&value)) {
                let message = format!("every call passes {value} for {}", &file.code[parameter.byte_range()]);
                findings.push(Finding::at(*parameter, &file.code, "single-use-abstraction", message));
            }
        }
    }
    findings
}

/// Where in its file the function `node` defines is: in another function, in what holds methods, or neither.
fn defined(node: Node, file: &File) -> Defined {
    let syntax = file.language.syntax();
    let mut above = node.parent();
    while let Some(holder) = above {
        if is_function(holder, file) {
            return Defined::Local(holder.start_byte());
        }
        if syntax.methods.contains(&holder.kind()) {
            return Defined::Method;
        }
        above = holder.parent();
    }
    Defined::Free
}

/// The functions `node` is in, the nearest first.
fn functions_around<'a>(node: Node<'a>, file: &File) -> impl Iterator<Item = Node<'a>> {
    std::iter::successors(node.parent(), Node::parent).filter(|holder| is_function(*holder, file))
}

/// Whether `node` is a function: one defined by name, a closure, a lambda or an arrow function.
fn is_function(node: Node, file: &File) -> bool {
    let syntax = file.language.syntax();
    syntax.functions.contains(&node.kind()) || syntax.function_values.contains(&node.kind())
}

/// The name of the function `node` calls, what it passes it, and whether it calls it through a receiver or a path:
/// `light(a)`, `beacons.light(a)`, `chain::light(a)`.
fn call<'a>(node: Node, file: &'a File) -> Option<(&'a str, Passed, bool)> {
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
    Some((&file.code[name.byte_range()], passed, name != function))
}

/// The name a node gives itself.
fn named<'a>(node: Node, file: &'a File) -> Option<&'a str> {
    let name = node.child_by_field_name("name")?;
    Some(&file.code[name.byte_range()])
}

/// `trait Store`
pub fn rust_interface<'a>(node: Node, file: &'a File) -> Option<&'a str> {
    if node.kind() != "trait_item" {
        return None;
    }
    named(node, file)
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
    if node.kind() != "class_definition" || !python_bases(node, file).any(|supertype| supertype == "ABC") {
        return None;
    }
    named(node, file)
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
    if !matches!(node.kind(), "interface_declaration" | "abstract_class_declaration") {
        return None;
    }
    named(node, file)
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
