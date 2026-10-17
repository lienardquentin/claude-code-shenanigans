//! Every file a rule may look across, each parsed once.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use tree_sitter::{Node, Parser, Tree};

use crate::cache::Cache;
use crate::config::Config;
use crate::git::{self, git};
use crate::lang::Language;
use crate::parallel;
use crate::rules::{self, Indexes};
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
        let (name, function) = if syntax.functions.contains(&node.kind()) {
            (node.child_by_field_name("name")?, node)
        } else {
            let binding = syntax.bindings.iter().find(|binding| binding.kind == node.kind())?;
            let value = node
                .child_by_field_name(binding.value)
                .filter(|value| syntax.function_values.contains(&value.kind()))?;
            // A name, not `{ a, b }`, `(a, b)` or `self.light`
            let name = node
                .child_by_field_name(binding.name)
                .filter(|name| name.kind() == "identifier")?;
            (name, value)
        };
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

/// The files judged, and the indexes of the rules that look across the project.
pub struct Project {
    pub files: Vec<File>,
    pub indexes: Indexes,
}

impl Project {
    /// The files judged, and the indexes of them and, in a git repository, of every other file of a language orcrist
    /// reads below the current folder, tracked or not yet, that the working tree holds. Each of those others is let go
    /// once indexed. One that cannot be read, a bundle that is not UTF-8, is left out with a word on stderr: it is no
    /// file the person asked to be judged. So is one the config leaves out, without a word.
    pub fn load(judged: &[PathBuf], config: &Config) -> Result<Project, String> {
        let judged: Vec<PathBuf> = judged.iter().map(|path| normal(path)).collect();
        let judging: HashSet<&PathBuf> = judged.iter().collect();
        let others: Vec<PathBuf> = repository_files()?
            .into_iter()
            .filter(|path| !judging.contains(path) && !config.ignores(path) && path.exists())
            .collect();
        let files = parallel::map(&judged, |path| parse(path.clone()))
            .into_iter()
            .collect::<Result<Vec<_>, _>>()?;
        let settings = &config.settings;
        let mut indexes = Indexes::new(settings);
        for (file, found) in files
            .iter()
            .zip(parallel::map(&files, |file| rules::find(file, settings)))
        {
            indexes.add(&file.path, file.language, found);
        }
        let cache = Cache::open(settings);
        let found = parallel::map(&others, |path| {
            let (language, source) = read(path)?;
            let found = cache.found(language, &source, || {
                rules::find(&parse_source(path.clone(), language, &source), settings)
            });
            Ok::<_, String>((language, found))
        });
        for (path, found) in others.iter().zip(found) {
            match found {
                Ok((language, found)) => indexes.add(path, language, found),
                Err(error) => eprintln!("orcrist: left out of the project: {error}"),
            }
        }
        cache.prune();
        Ok(Project { files, indexes })
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
    let (language, source) = read(&path)?;
    Ok(parse_source(path, language, &source))
}

/// The language of the file at `path`, and its content.
fn read(path: &Path) -> Result<(Language, String), String> {
    let language = Language::of(path)
        .ok_or_else(|| format!("no language orcrist reads has the extension of {}", path.display()))?;
    let source = fs::read_to_string(path).map_err(|error| format!("cannot read {}: {error}", path.display()))?;
    Ok((language, source))
}

fn parse_source(path: PathBuf, language: Language, source: &str) -> File {
    let code = language.code(source).into_owned();
    let mut parser = Parser::new();
    parser
        .set_language(&language.grammar(source))
        .expect("every grammar matches tree-sitter's version");
    let tree = parser
        .parse(&code, None)
        .expect("a parser with a language set always parses");
    File {
        path,
        language,
        code,
        tree,
    }
}
