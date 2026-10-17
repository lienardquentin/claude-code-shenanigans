//! An error the code drops where the caller or the person needed to know of it.

use tree_sitter::Node;

use crate::rules::Finding;

pub fn judge(node: Node, source: &str) -> Option<Finding> {
    let message = match node.kind() {
        "expression_statement" if ok_dropped(node, source) => "the error is turned into an Option and dropped",
        "let_declaration" if call_bound_to_wildcard(node, source) => {
            "what the call returns, an error among it, is bound to _ and dropped"
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
