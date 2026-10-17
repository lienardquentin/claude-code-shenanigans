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

/// `catch {}`
pub fn catches_nothing(catch: Node, _source: &str) -> bool {
    catch.child_by_field_name("body").is_some_and(is_empty)
}

/// `{}`, or a block of nothing but comments
fn is_empty(block: Node) -> bool {
    let mut cursor = block.walk();
    block.named_children(&mut cursor).all(|child| child.kind() == "comment")
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
