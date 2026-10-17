//! Every file a rule may look across, each parsed once.

use std::fs;
use std::path::{Path, PathBuf};

use tree_sitter::{Parser, Tree};

use crate::git::{self, git};
use crate::lang::Language;

pub struct File {
    pub path: PathBuf,
    pub language: Language,
    /// What the grammar reads of the file, line for line where it stands in it
    pub code: String,
    pub tree: Tree,
}

pub struct Project {
    pub files: Vec<File>,
}

impl Project {
    /// The files judged, and in a git repository every other file of a language orcrist reads below the current
    /// folder, tracked or not yet, that the working tree holds.
    pub fn load(judged: &[PathBuf]) -> Result<Project, String> {
        let mut paths: Vec<PathBuf> = judged.iter().map(|path| normal(path)).collect();
        for path in repository_files()? {
            if !paths.contains(&path) && path.exists() {
                paths.push(path);
            }
        }
        let files = paths.into_iter().map(parse).collect::<Result<_, _>>()?;
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
