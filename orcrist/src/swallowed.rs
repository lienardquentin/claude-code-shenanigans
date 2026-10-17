//! An error the code drops where the caller or the person needed to know of it.

use tree_sitter::Node;

use crate::lang::Language;
use crate::rules::Finding;

pub fn judge(node: Node, source: &str, language: Language) -> Option<Finding> {
    let message = match (language, node.kind()) {
        (Language::Rust, "expression_statement") if ok_dropped(node, source) => {
            "the error is turned into an Option and dropped"
        }
        (Language::Rust, "let_declaration") if call_bound_to_wildcard(node, source) => {
            "what the call returns, an error among it, is bound to _ and dropped"
        }
        (Language::Python, "except_clause") if only_passes(node, source) => {
            "the error is caught and nothing is done with it"
        }
        (Language::TypeScript | Language::Vue, "catch_clause")
            if node.child_by_field_name("body").is_some_and(is_empty) =>
        {
            "the error is caught and nothing is done with it"
        }
        (Language::TypeScript | Language::Vue, "call_expression") if catches_with_nothing(node, source) => {
            "the error is caught and nothing is done with it"
        }
        _ => return None,
    };
    Some(Finding {
        line: node.start_position().row + 1,
        rule: "swallowed-error",
        message: message.to_string(),
    })
}

/// `write(path).ok();`
fn ok_dropped(statement: Node, source: &str) -> bool {
    let Some(call) = statement
        .named_child(0)
        .filter(|child| child.kind() == "call_expression")
    else {
        return false;
    };
    let method = call
        .child_by_field_name("function")
        .and_then(|function| function.child_by_field_name("field"));
    let arguments = call.child_by_field_name("arguments");
    method.is_some_and(|method| &source[method.byte_range()] == "ok")
        && arguments.is_some_and(|arguments| arguments.named_child_count() == 0)
}

/// `let _ = write(path);`
fn call_bound_to_wildcard(declaration: Node, source: &str) -> bool {
    let pattern = declaration.child_by_field_name("pattern");
    let value = declaration.child_by_field_name("value");
    pattern.is_some_and(|pattern| &source[pattern.byte_range()] == "_")
        && value.is_some_and(|value| value.kind() == "call_expression")
}

/// `except OSError: pass`, but not `except KeyboardInterrupt: pass`, which is how a program stops quietly on Ctrl+C
fn only_passes(except: Node, source: &str) -> bool {
    let mut cursor = except.walk();
    let children: Vec<Node> = except.named_children(&mut cursor).collect();
    let Some(block) = children.iter().find(|child| child.kind() == "block") else {
        return false;
    };
    if children
        .iter()
        .any(|child| &source[child.byte_range()] == "KeyboardInterrupt")
    {
        return false;
    }
    let mut cursor = block.walk();
    let statements: Vec<Node> = block
        .named_children(&mut cursor)
        .filter(|statement| statement.kind() != "comment")
        .collect();
    !statements.is_empty() && statements.iter().all(|statement| statement.kind() == "pass_statement")
}

/// `{}`, or a block of nothing but comments
fn is_empty(block: Node) -> bool {
    let mut cursor = block.walk();
    block.named_children(&mut cursor).all(|child| child.kind() == "comment")
}

/// `promise.catch(() => {})`
fn catches_with_nothing(call: Node, source: &str) -> bool {
    let method = call
        .child_by_field_name("function")
        .filter(|function| function.kind() == "member_expression")
        .and_then(|function| function.child_by_field_name("property"));
    let handler = call
        .child_by_field_name("arguments")
        .and_then(|arguments| arguments.named_child(0))
        .filter(|handler| handler.kind() == "arrow_function");
    let body = handler.and_then(|handler| handler.child_by_field_name("body"));
    method.is_some_and(|method| &source[method.byte_range()] == "catch")
        && body.is_some_and(|body| body.kind() == "statement_block" && is_empty(body))
}
