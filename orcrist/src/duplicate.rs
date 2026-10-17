//! A function that does what another of the project already does: the same code, its own names aside.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

use tree_sitter::Node;

use crate::lang::{Language, declared};
use crate::project::{self, File, Project};
use crate::rules::{Finding, visit};

/// Pieces of code below which two functions alike are alike by chance: a getter, a call passed on.
const SMALLEST: usize = 24;

/// What a function does, in the language of its code: see `shape`.
type Shape = (Language, Vec<String>);

/// Each function of the project worth comparing, by what it does: where it is and its name.
pub struct Index {
    functions: HashMap<Shape, Vec<(PathBuf, usize, String)>>,
}

impl Index {
    pub fn build(project: &Project) -> Index {
        let mut functions: HashMap<Shape, Vec<(PathBuf, usize, String)>> = HashMap::new();
        for file in &project.files {
            visit(file.tree.root_node(), &mut |node| {
                if let Some((name, shape)) = shape(node, file) {
                    let line = node.start_position().row + 1;
                    functions
                        .entry((file.language.code_language(), shape))
                        .or_default()
                        .push((file.path.clone(), line, name.to_string()));
                }
            });
        }
        Index { functions }
    }
}

pub fn judge(node: Node, file: &File, index: &Index) -> Option<Finding> {
    let (name, shape) = shape(node, file)?;
    let line = node.start_position().row + 1;
    let (path, other_line, other) = index
        .functions
        .get(&(file.language.code_language(), shape))?
        .iter()
        .find(|(path, other_line, _)| (path, *other_line) != (&file.path, line))?;
    Some(Finding {
        line,
        rule: "duplicate-helper",
        message: format!(
            "{name} does what {other} in {}:{other_line} already does",
            path.display()
        ),
    })
}

/// The name of the function `node` defines, and what it does: the pieces of its parameters and body in order, each
/// name it declares itself given by when it first comes, every other piece as it is written.
fn shape<'a>(node: Node<'a>, file: &'a File) -> Option<(&'a str, Vec<String>)> {
    let (name, function) = file.defined(node)?;
    let parameters = project::parameters(function)?;
    let body = function.child_by_field_name("body")?;
    let mut own = HashSet::new();
    // `beacon => …`: its one parameter is a name of its own, though no declaration names it
    if parameters.kind() == "identifier" {
        own.insert(&file.code[parameters.byte_range()]);
    }
    for part in [parameters, body] {
        visit(part, &mut |piece| {
            // Only an identifier is renamed below, so only an identifier's declaring is asked: asking climbs the tree
            if piece.kind() == "identifier" && declared(piece, file.language).is_some() {
                own.insert(&file.code[piece.byte_range()]);
            }
        });
    }
    let mut renamed: HashMap<&str, usize> = HashMap::new();
    let mut pieces = Vec::new();
    for part in [parameters, body] {
        visit(part, &mut |piece| {
            if piece.child_count() > 0 || file.language.is_comment(piece) {
                return;
            }
            let text = &file.code[piece.byte_range()];
            if piece.kind() == "identifier" && own.contains(text) {
                let next = renamed.len();
                pieces.push(format!("${}", renamed.entry(text).or_insert(next)));
            } else {
                pieces.push(text.to_string());
            }
        });
    }
    (pieces.len() >= SMALLEST).then_some((name, pieces))
}
