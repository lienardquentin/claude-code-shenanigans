//! The languages deslop reads, told apart by the extension of a file's name.

use std::borrow::Cow;
use std::ops::Range;
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
    /// The pathspecs git is given to list the files of every language deslop reads.
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

    /// The grammar `source` is read with: a Vue component's TSX's when a `<script>` of it says `lang="tsx"` or `"jsx"`,
    /// which Vue asks all its scripts to share.
    pub fn grammar(self, source: &str) -> tree_sitter::Language {
        let jsx =
            |(tag, _): (&str, Range<usize>)| ["tsx", "jsx"].iter().any(|lang| attribute(tag, "lang") == Some(lang));
        match self {
            Language::Rust => tree_sitter_rust::LANGUAGE.into(),
            Language::Python => tree_sitter_python::LANGUAGE.into(),
            Language::Vue if scripts(source).into_iter().any(jsx) => tree_sitter_typescript::LANGUAGE_TSX.into(),
            Language::TypeScript | Language::Vue => tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
            Language::Jsx => tree_sitter_typescript::LANGUAGE_TSX.into(),
        }
    }

    /// What deslop knows of the language's grammar.
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

    /// The code of `source` its grammar reads, each byte where it stands in the file: a Vue component's outside its
    /// `<script>` blocks made spaces, its line ends kept.
    pub fn code(self, source: &str) -> Cow<'_, str> {
        if self != Language::Vue {
            return Cow::Borrowed(source);
        }
        let mut code: Vec<u8> = source
            .bytes()
            .map(|byte| if byte == b'\n' { b'\n' } else { b' ' })
            .collect();
        for (_, script) in scripts(source) {
            code[script.clone()].copy_from_slice(&source.as_bytes()[script]);
        }
        Cow::Owned(String::from_utf8(code).expect("only whole characters are copied, the rest are spaces"))
    }
}

/// Each `<script>` block of a Vue component: its opening tag, and where its code is.
fn scripts(source: &str) -> Vec<(&str, Range<usize>)> {
    let mut found = Vec::new();
    let mut from = 0;
    while let Some(open) = source[from..].find("<script").map(|at| from + at) {
        // A `<script` in an HTML comment is no script: past the comment's end
        if let Some(comment) = source[from..open].rfind("<!--").map(|at| from + at)
            && !source[comment..open].contains("-->")
        {
            from = source[open..].find("-->").map_or(source.len(), |at| open + at + 3);
            continue;
        }
        // `<script` and no more of a tag's name: not `<scripted>`
        let named = source[open + "<script".len()..]
            .chars()
            .next()
            .is_some_and(|after| after.is_whitespace() || after == '>' || after == '/');
        if !named {
            from = open + "<script".len();
            continue;
        }
        let Some(code_start) = tag_end(source, open) else {
            break;
        };
        let tag = &source[open..code_start];
        if tag.ends_with("/>") {
            from = code_start;
            continue;
        }
        let code_end = source[code_start..]
            .find("</script")
            .map_or(source.len(), |at| code_start + at);
        found.push((tag, code_start..code_end));
        from = code_end;
    }
    found
}

/// Where the tag opened at `open` ends, past its `>`: the first outside its attributes' quotes, as
/// `generic="T extends Map<K, V>"` holds some.
fn tag_end(source: &str, open: usize) -> Option<usize> {
    let mut quote = None;
    for (at, character) in source[open..].char_indices() {
        match quote {
            Some(open_quote) if character == open_quote => quote = None,
            #[allow(
                clippy::match_same_arms,
                reason = "the guarded arms between the two must be tried before either"
            )]
            Some(_) => {}
            None if matches!(character, '"' | '\'') => quote = Some(character),
            None if character == '>' => return Some(open + at + 1),
            None => {}
        }
    }
    None
}

/// The value an opening tag gives `name`, quoted or not: `lang="ts"` or `lang=ts`, not `data-lang="ts"`.
fn attribute<'a>(tag: &'a str, name: &str) -> Option<&'a str> {
    let given = format!("{name}=");
    let (at, _) = tag
        .match_indices(&given)
        .find(|(at, _)| tag[..*at].ends_with(char::is_whitespace))?;
    let after = &tag[at + given.len()..];
    match after.chars().next()? {
        quote @ ('"' | '\'') => after[1..].split(quote).next(),
        // `lang=tsx`, unquoted, up to the next space or the tag's end
        _ => after
            .split(|end: char| end.is_whitespace() || end == '>' || end == '/')
            .next()
            .filter(|value| !value.is_empty()),
    }
}

/// What a comment says, without the marks that make it one.
pub fn comment_text(comment: &str) -> &str {
    comment
        .trim_start_matches(['/', '#', '*', '!'])
        .trim_end_matches(['/', '*'])
        .trim()
}

#[derive(Clone, Copy)]
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
    if syntax.functions.contains(&kind) {
        return is("name").then_some(Declared::Function);
    }
    let binding = syntax.bindings.iter().find(|binding| binding.kind == kind);
    let binds_function = binding.filter(|binding| {
        parent
            .child_by_field_name(binding.value)
            .is_some_and(|value| syntax.function_values.contains(&value.kind()))
    });
    if let Some(binding) = binds_function {
        return is(binding.name).then_some(Declared::Function);
    }
    let (_, place) = syntax.declarations.iter().find(|(declaring, _)| *declaring == kind)?;
    let declares = match place {
        Place::Field(field) => is(field),
        Place::First => name.prev_sibling().is_none(),
        Place::Any => true,
    };
    declares.then_some(Declared::Value)
}
