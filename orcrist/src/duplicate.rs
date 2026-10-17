//! A function that does what another of the project already does: the same code, its own names aside.

use std::collections::hash_map::DefaultHasher;
use std::collections::{HashMap, HashSet};
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tree_sitter::Node;

use crate::lang::{Language, declared};
use crate::project::{self, File};
use crate::rules::{Finding, visit};

/// Pieces of code below which two functions alike are alike by chance: a getter, a call passed on.
pub const SMALLEST: usize = 24;

/// What a function does, in the language of its code: a hash of its `shape`. Two shapes share one by chance one in
/// 2^64; a function written to collide with another would be reported as doing what it does, and nothing worse.
type Shape = (Language, u64);

/// Each function of the project worth comparing, gathered by what it does: where it is and its name.
#[derive(Default)]
pub struct Index {
    /// The functions that do one same thing
    groups: Vec<Vec<(PathBuf, usize, String)>>,
    /// The group of the function starting at each byte of each file, so that judging it does not shape it again
    group_at: HashMap<PathBuf, HashMap<usize, usize>>,
    /// The group of each shape
    group_of: HashMap<Shape, usize>,
}

/// What one file holds for the index: each function worth comparing, where it starts, its line, its name and what it
/// does, hashed.
#[derive(Serialize, Deserialize)]
pub struct Found(Vec<(usize, usize, String, u64)>);

pub fn find(file: &File, smallest: usize) -> Found {
    let mut shapes = Vec::new();
    visit(file.tree.root_node(), &mut |node| {
        if let Some((name, shape)) = shape(node, file, smallest) {
            let mut hashed = DefaultHasher::new();
            shape.hash(&mut hashed);
            let line = node.start_position().row + 1;
            shapes.push((node.start_byte(), line, name.to_string(), hashed.finish()));
        }
    });
    Found(shapes)
}

impl Index {
    /// What one file of `language` at `path` holds, added in the order the files are.
    pub fn add(&mut self, path: &Path, language: Language, found: Found) {
        for (start, line, name, shape) in found.0 {
            let next = self.groups.len();
            let group = *self.group_of.entry((language.code_language(), shape)).or_insert(next);
            if group == next {
                self.groups.push(Vec::new());
            }
            self.groups[group].push((path.to_path_buf(), line, name));
            self.group_at
                .entry(path.to_path_buf())
                .or_default()
                .insert(start, group);
        }
    }
}

pub fn judge(node: Node, file: &File, index: &Index) -> Option<Finding> {
    let group = *index.group_at.get(&file.path)?.get(&node.start_byte())?;
    let (name, _) = file.defined(node)?;
    let line = node.start_position().row + 1;
    let (path, other_line, other) = index.groups[group]
        .iter()
        .find(|(path, other_line, _)| (path, *other_line) != (&file.path, line))?;
    let message = format!(
        "{name} does what {other} in {}:{other_line} already does",
        path.display()
    );
    Some(Finding::at(node, &file.code, "duplicate-helper", message))
}

/// The name of the function `node` defines, and what it does: the pieces of its parameters and body in order, each
/// name it declares itself given by when it first comes, every other piece as it is written.
fn shape<'a>(node: Node<'a>, file: &'a File, smallest: usize) -> Option<(&'a str, Vec<String>)> {
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
    (pieces.len() >= smallest).then_some((name, pieces))
}
