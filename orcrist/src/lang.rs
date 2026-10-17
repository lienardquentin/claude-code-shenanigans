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

pub enum Declared {
    Function,
    Value,
}

/// What `name` names, when it is where a function, a variable or a parameter is named rather than where one is used.
pub fn declared(name: Node, language: Language) -> Option<Declared> {
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
