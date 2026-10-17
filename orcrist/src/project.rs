//! Every file a rule may look across, each parsed once.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use tree_sitter::{Node, Parser, Tree};

use crate::config::Config;
use crate::git::{self, git};
use crate::lang::Language;
use crate::parallel;
use crate::syntax::Holds;

pub struct File {
    pub path: PathBuf,
    pub language: Language,
    /// What the grammar reads of the file, line for line where it stands in it
    pub code: String,
    pub tree: Tree,
}

impl File {
    /// The name of the function `node` defines, and the function itself: `node`, or its value where a variable holds
    /// the function, as in `const light = (beacon) => …`.
    pub fn defined<'a>(&'a self, node: Node<'a>) -> Option<(&'a str, Node<'a>)> {
        let syntax = self.language.syntax();
        let function = if syntax.functions.contains(&node.kind()) {
            node
        } else if syntax.bindings.contains(&node.kind()) {
            node.child_by_field_name("value")
                .filter(|value| syntax.function_values.contains(&value.kind()))?
        } else {
            return None;
        };
        let name = node
            .child_by_field_name("name")
            .filter(|name| !matches!(name.kind(), "object_pattern" | "array_pattern"))?;
        Some((&self.code[name.byte_range()], function))
    }

    /// The name of the function `node` defines, and the names of the parameters a call passes, a method's own receiver
    /// left out.
    pub fn function<'a>(&'a self, node: Node<'a>) -> Option<(&'a str, Vec<Node<'a>>)> {
        let (name, function) = self.defined(node)?;
        let parameters = parameters(function)?;
        // `beacon => …`, its one parameter without parentheses
        if parameters.kind() == "identifier" {
            return Some((name, vec![parameters]));
        }
        let syntax = self.language.syntax();
        let mut cursor = parameters.walk();
        let names = parameters
            .named_children(&mut cursor)
            .filter_map(|parameter| {
                let (_, place) = syntax.parameters.iter().find(|(kind, _)| *kind == parameter.kind())?;
                match place {
                    Holds::Field(field) => parameter.child_by_field_name(field),
                    Holds::First => parameter.named_child(0),
                    Holds::Itself => Some(parameter),
                }
            })
            .filter(|name| !syntax.receivers.contains(&&self.code[name.byte_range()]))
            .collect();
        Some((name, names))
    }
}

/// What holds a function's parameters: their list, or the one name of an arrow function written without parentheses.
pub fn parameters(function: Node) -> Option<Node> {
    function
        .child_by_field_name("parameters")
        .or_else(|| function.child_by_field_name("parameter"))
}

pub struct Project {
    pub files: Vec<File>,
}

impl Project {
    /// The files judged, and in a git repository every other file of a language orcrist reads below the current
    /// folder, tracked or not yet, that the working tree holds. One of those others that cannot be read, a bundle that
    /// is not UTF-8, is left out with a word on stderr: it is no file the person asked to be judged. So is one the
    /// config leaves out, without a word.
    pub fn load(judged: &[PathBuf], config: &Config) -> Result<Project, String> {
        let judged: Vec<PathBuf> = judged.iter().map(|path| normal(path)).collect();
        let judging: HashSet<&PathBuf> = judged.iter().collect();
        let others: Vec<PathBuf> = repository_files()?
            .into_iter()
            .filter(|path| !judging.contains(path) && !config.ignores(path) && path.exists())
            .collect();
        let mut files = parallel::map(&judged, |path| parse(path.clone()))
            .into_iter()
            .collect::<Result<Vec<_>, _>>()?;
        for parsed in parallel::map(&others, |path| parse(path.clone())) {
            match parsed {
                Ok(file) => files.push(file),
                Err(error) => eprintln!("orcrist: left out of the project: {error}"),
            }
        }
        Ok(Project { files })
    }

    pub fn file(&self, path: &Path) -> Option<&File> {
        let path = normal(path);
        self.files.iter().find(|file| file.path == path)
    }
}

/// `./src/main.rs` and `src/main.rs` as one path.
fn normal(path: &Path) -> PathBuf {
    path.components().collect()
}

fn repository_files() -> Result<Vec<PathBuf>, String> {
    if !git::inside_repository() {
        return Ok(Vec::new());
    }
    let listed = git(&[
        &[
            "ls-files",
            "--cached",
            "--others",
            "--exclude-standard",
            "--deduplicate",
            "-z",
            "--",
        ],
        &Language::PATHSPECS[..],
    ]
    .concat())?;
    Ok(listed
        .split('\0')
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)
        .collect())
}

fn parse(path: PathBuf) -> Result<File, String> {
    let language = Language::of(&path)
        .ok_or_else(|| format!("no language orcrist reads has the extension of {}", path.display()))?;
    let source = fs::read_to_string(&path).map_err(|error| format!("cannot read {}: {error}", path.display()))?;
    let code = language.code(&source).into_owned();
    let mut parser = Parser::new();
    parser
        .set_language(&language.grammar())
        .expect("every grammar matches tree-sitter's version");
    let tree = parser
        .parse(&code, None)
        .expect("a parser with a language set always parses");
    Ok(File {
        path,
        language,
        code,
        tree,
    })
}
