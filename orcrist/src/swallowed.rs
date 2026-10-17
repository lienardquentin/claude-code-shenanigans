//! An error the code drops where the caller or the person needed to know of it.

use tree_sitter::Node;

use crate::lang::Language;
use crate::rules::Finding;

pub fn judge(node: Node, source: &str, language: Language) -> Option<Finding> {
    let swallowed = language
        .syntax()
        .swallowed
        .iter()
        .find(|swallowed| swallowed.kind == node.kind() && (swallowed.drops)(node, source))?;
    Some(Finding::at(
        node,
        source,
        "swallowed-error",
        swallowed.message.to_string(),
    ))
}

/// `write(path).ok();`
pub fn ok_dropped(statement: Node, source: &str) -> bool {
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
pub fn call_bound_to_wildcard(declaration: Node, source: &str) -> bool {
    let pattern = declaration.child_by_field_name("pattern");
    let value = declaration.child_by_field_name("value");
    pattern.is_some_and(|pattern| &source[pattern.byte_range()] == "_")
        && value.is_some_and(|value| value.kind() == "call_expression")
}

/// `except OSError: pass`, but not `except KeyboardInterrupt: pass`, which is how a program stops quietly on Ctrl+C
pub fn only_passes(except: Node, source: &str) -> bool {
    let mut cursor = except.walk();
    let children: Vec<Node> = except.named_children(&mut cursor).collect();
    let Some(block) = children.iter().find(|child| child.kind() == "block") else {
        return false;
    };
    // Ctrl+C stopping quietly, and a module that is optional when it cannot be imported
    let meant = ["KeyboardInterrupt", "ImportError", "ModuleNotFoundError"];
    if children
        .iter()
        .any(|child| meant.contains(&&source[child.byte_range()]))
    {
        return false;
    }
    let mut cursor = block.walk();
    let statements: Vec<Node> = block
        .named_children(&mut cursor)
        .filter(|statement| statement.kind() != "comment")
        .collect();
    let nothing = |statement: &Node| {
        statement.kind() == "pass_statement"
            || (statement.kind() == "expression_statement" && &source[statement.byte_range()] == "...")
    };
    !statements.is_empty() && statements.iter().all(nothing)
}

/// `catch {}`
pub fn catches_nothing(catch: Node, _source: &str) -> bool {
    catch.child_by_field_name("body").is_some_and(is_empty)
}

/// `{}`, a block of nothing but comments, or of a `return` that gives nothing back
fn is_empty(block: Node) -> bool {
    let mut cursor = block.walk();
    block.named_children(&mut cursor).all(|child| {
        child.kind() == "comment" || (child.kind() == "return_statement" && child.named_child_count() == 0)
    })
}

/// `if let Err(_) = write(path) {}`: the error matched and nothing done with it
pub fn err_ignored(expression: Node, source: &str) -> bool {
    let Some(condition) = expression.child_by_field_name("condition") else {
        return false;
    };
    let matches_err = condition.kind() == "let_condition"
        && condition
            .child_by_field_name("pattern")
            .is_some_and(|pattern| source[pattern.byte_range()].replace(' ', "") == "Err(_)");
    let consequence = expression.child_by_field_name("consequence");
    let alternative = expression.child_by_field_name("alternative");
    let empty = consequence.is_some_and(|block| {
        let mut cursor = block.walk();
        block
            .named_children(&mut cursor)
            .all(|child| matches!(child.kind(), "line_comment" | "block_comment"))
    });
    matches_err && empty && alternative.is_none()
}

/// `promise.catch(() => {})`
pub fn catches_with_nothing(call: Node, source: &str) -> bool {
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
