//! The languages orcrist reads, told apart by the extension of a file's name.

use std::borrow::Cow;
use std::path::Path;

use tree_sitter::Node;

#[derive(Clone, Copy, PartialEq)]
pub enum Language {
    Rust,
    Python,
    TypeScript,
    /// A Vue component, whose `<script>` is TypeScript
    Vue,
}

impl Language {
    /// The pathspecs git is given to list the files of every language orcrist reads.
    pub const PATHSPECS: [&str; 4] = ["*.rs", "*.py", "*.ts", "*.vue"];

    pub fn of(path: &Path) -> Option<Language> {
        match path.extension()?.to_str()? {
            "rs" => Some(Language::Rust),
            "py" => Some(Language::Python),
            "ts" => Some(Language::TypeScript),
            "vue" => Some(Language::Vue),
            _ => None,
        }
    }

    pub fn grammar(self) -> tree_sitter::Language {
        match self {
            Language::Rust => tree_sitter_rust::LANGUAGE.into(),
            Language::Python => tree_sitter_python::LANGUAGE.into(),
            Language::TypeScript | Language::Vue => tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
        }
    }

    pub fn is_comment(self, node: Node) -> bool {
        match self {
            Language::Rust => matches!(node.kind(), "line_comment" | "block_comment"),
            Language::Python | Language::TypeScript | Language::Vue => node.kind() == "comment",
        }
    }

    /// The code of `source` its grammar reads, line for line where it stands in the file: a Vue component's lines
    /// outside its `<script>` left empty.
    pub fn code(self, source: &str) -> Cow<'_, str> {
        if self != Language::Vue {
            return Cow::Borrowed(source);
        }
        let mut in_script = false;
        let mut code = String::with_capacity(source.len());
        for line in source.lines() {
            let trimmed = line.trim_start();
            if trimmed.starts_with("</script") {
                in_script = false;
            } else if in_script {
                code.push_str(line);
            } else if trimmed.starts_with("<script") {
                in_script = true;
            }
            code.push('\n');
        }
        Cow::Owned(code)
    }
}

/// What a comment says, without the marks that make it one.
pub fn comment_text(comment: &str) -> &str {
    comment
        .trim_start_matches(['/', '#', '*', '!'])
        .trim_end_matches(['/', '*'])
        .trim()
}
