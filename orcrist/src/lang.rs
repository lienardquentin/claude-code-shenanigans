//! The languages orcrist reads, told apart by the extension of a file's name.

use std::borrow::Cow;
use std::path::Path;

use tree_sitter::Node;

use crate::syntax::{self, Place, Syntax};

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub enum Language {
    Rust,
    Python,
    TypeScript,
    /// TypeScript or JavaScript in a file that may hold JSX: `.tsx`, `.jsx`, `.js`, `.mjs`, `.cjs`
    Jsx,
    /// A Vue component, whose `<script>` is TypeScript
    Vue,
}

impl Language {
    /// The pathspecs git is given to list the files of every language orcrist reads.
    pub const PATHSPECS: [&str; 11] = [
        "*.rs", "*.py", "*.ts", "*.mts", "*.cts", "*.tsx", "*.js", "*.mjs", "*.cjs", "*.jsx", "*.vue",
    ];

    pub fn of(path: &Path) -> Option<Language> {
        match path.extension()?.to_str()? {
            "rs" => Some(Language::Rust),
            "py" => Some(Language::Python),
            "ts" | "mts" | "cts" => Some(Language::TypeScript),
            // JavaScript is read as TypeScript without annotations, and may hold JSX as a `.tsx` does
            "tsx" | "js" | "mjs" | "cjs" | "jsx" => Some(Language::Jsx),
            "vue" => Some(Language::Vue),
            _ => None,
        }
    }

    /// The language the code of a file is written in, where names are shared: a Vue component's, a `.tsx`'s and
    /// JavaScript's are TypeScript.
    pub fn code_language(self) -> Language {
        match self {
            Language::Jsx | Language::Vue => Language::TypeScript,
            language => language,
        }
    }

    pub fn grammar(self) -> tree_sitter::Language {
        match self {
            Language::Rust => tree_sitter_rust::LANGUAGE.into(),
            Language::Python => tree_sitter_python::LANGUAGE.into(),
            Language::TypeScript | Language::Vue => tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
            Language::Jsx => tree_sitter_typescript::LANGUAGE_TSX.into(),
        }
    }

    /// What orcrist knows of the language's grammar.
    pub fn syntax(self) -> &'static Syntax {
        match self {
            Language::Rust => &syntax::RUST,
            Language::Python => &syntax::PYTHON,
            Language::TypeScript | Language::Jsx | Language::Vue => &syntax::TYPESCRIPT,
        }
    }

    pub fn is_comment(self, node: Node) -> bool {
        self.syntax().comments.contains(&node.kind())
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
    let syntax = language.syntax();
    let kind = parent.kind();
    let value_is_function = || {
        parent
            .child_by_field_name("value")
            .is_some_and(|value| syntax.function_values.contains(&value.kind()))
    };
    if syntax.functions.contains(&kind) || (syntax.bindings.contains(&kind) && value_is_function()) {
        return is("name").then_some(Declared::Function);
    }
    let (_, place) = syntax.declarations.iter().find(|(declaring, _)| *declaring == kind)?;
    let declares = match place {
        Place::Field(field) => is(field),
        Place::First => name.prev_sibling().is_none(),
        Place::Any => true,
    };
    declares.then_some(Declared::Value)
}
