//! A guard for what cannot happen: a check on a parameter that its own signature already decides.

use tree_sitter::Node;

use crate::lang::Language;
use crate::rules::Finding;

pub fn judge(guard: Node, source: &str, language: Language) -> Option<Finding> {
    let (name, annotation) = match (language, guard.kind()) {
        (Language::Python, "call") => python_isinstance(guard, source)?,
        (Language::Python, "comparison_operator") => python_none_check(guard, source)?,
        (Language::TypeScript | Language::Jsx | Language::Vue, "binary_expression") => {
            typescript_comparison(guard, source)?
        }
        (Language::TypeScript | Language::Jsx | Language::Vue, "member_expression") => {
            typescript_optional_chain(guard, source)?
        }
        _ => return None,
    };
    Some(Finding {
        line: guard.start_position().row + 1,
        rule: "impossible-guard",
        message: format!("the signature already says {name} is {annotation}"),
    })
}

/// `isinstance(path, str)` where the signature says `path: str`
fn python_isinstance<'a>(call: Node, source: &'a str) -> Option<(&'a str, &'a str)> {
    let function = call.child_by_field_name("function")?;
    let arguments = call.child_by_field_name("arguments")?;
    if &source[function.byte_range()] != "isinstance" || arguments.named_child_count() != 2 {
        return None;
    }
    let name = arguments.named_child(0).filter(|name| name.kind() == "identifier")?;
    let checked = &source[arguments.named_child(1)?.byte_range()];
    let annotation = python_annotation(call, &source[name.byte_range()], source)?;
    (annotation == checked).then_some((&source[name.byte_range()], annotation))
}

/// `text is None` where the signature says `text: str`
fn python_none_check<'a>(comparison: Node, source: &'a str) -> Option<(&'a str, &'a str)> {
    let mut cursor = comparison.walk();
    let operands: Vec<Node> = comparison.named_children(&mut cursor).collect();
    let [name, none] = operands[..] else { return None };
    if name.kind() != "identifier" || none.kind() != "none" {
        return None;
    }
    let name = &source[name.byte_range()];
    let annotation = python_annotation(comparison, name, source)?;
    let may_be_none = ["None", "Optional", "Any", "object"]
        .iter()
        .any(|word| annotation.contains(word));
    (!may_be_none).then_some((name, annotation))
}

/// The annotation the function around `inside` gives its parameter `name`: None when it gives none, when its default
/// is None, or when the function assigns to it, so that what it holds is no longer what the signature says.
fn python_annotation<'a>(inside: Node, name: &str, source: &'a str) -> Option<&'a str> {
    let function = ancestors(inside).find(|node| node.kind() == "function_definition")?;
    let parameters = function.child_by_field_name("parameters")?;
    let mut cursor = parameters.walk();
    let parameter = parameters.named_children(&mut cursor).find(|parameter| {
        let named = match parameter.kind() {
            "typed_parameter" => parameter.named_child(0),
            "typed_default_parameter" => parameter.child_by_field_name("name"),
            _ => None,
        };
        named.is_some_and(|named| &source[named.byte_range()] == name)
    })?;
    let defaults_to_none = parameter
        .child_by_field_name("value")
        .is_some_and(|value| value.kind() == "none");
    if defaults_to_none || assigns(function.child_by_field_name("body")?, name, source) {
        return None;
    }
    Some(&source[parameter.child_by_field_name("type")?.byte_range()])
}

/// `path == null` or `typeof text !== 'string'`, where the signature says `path: string` and `text: string`
fn typescript_comparison<'a>(comparison: Node, source: &'a str) -> Option<(&'a str, &'a str)> {
    let operator = &source[comparison.child_by_field_name("operator")?.byte_range()];
    if !matches!(operator, "==" | "===" | "!=" | "!==") {
        return None;
    }
    let (left, right) = (
        comparison.child_by_field_name("left")?,
        comparison.child_by_field_name("right")?,
    );
    if left.kind() == "unary_expression" && source[left.byte_range()].starts_with("typeof") {
        let name = left
            .child_by_field_name("argument")
            .filter(|name| name.kind() == "identifier")?;
        let name = &source[name.byte_range()];
        let checked = source[right.byte_range()].trim_matches(['\'', '"', '`']);
        let annotation = typescript_annotation(comparison, name, source)?;
        return (annotation == checked).then_some((name, annotation));
    }
    let (name, nothing) = if left.kind() == "identifier" {
        (left, right)
    } else {
        (right, left)
    };
    if name.kind() != "identifier" || !matches!(nothing.kind(), "null" | "undefined") {
        return None;
    }
    let name = &source[name.byte_range()];
    typescript_annotation(comparison, name, source).map(|annotation| (name, annotation))
}

/// `text?.length`, where the signature says `text: string`
fn typescript_optional_chain<'a>(member: Node, source: &'a str) -> Option<(&'a str, &'a str)> {
    let receiver = member
        .child_by_field_name("object")
        .filter(|receiver| receiver.kind() == "identifier")?;
    let mut cursor = member.walk();
    if !member
        .children(&mut cursor)
        .any(|child| child.kind() == "optional_chain")
    {
        return None;
    }
    let name = &source[receiver.byte_range()];
    typescript_annotation(member, name, source).map(|annotation| (name, annotation))
}

/// The type the function around `inside` gives its parameter `name`, when that type holds neither null nor undefined:
/// None when it is optional, holds either, or is any, or when the function assigns to it.
fn typescript_annotation<'a>(inside: Node, name: &str, source: &'a str) -> Option<&'a str> {
    let function = ancestors(inside).find(|node| {
        matches!(
            node.kind(),
            "function_declaration" | "function_expression" | "arrow_function" | "method_definition"
        )
    })?;
    let parameters = function.child_by_field_name("parameters")?;
    let mut cursor = parameters.walk();
    let parameter = parameters.named_children(&mut cursor).find(|parameter| {
        parameter.kind() == "required_parameter"
            && parameter
                .child_by_field_name("pattern")
                .is_some_and(|pattern| &source[pattern.byte_range()] == name)
    })?;
    let annotation = &source[parameter.child_by_field_name("type")?.named_child(0)?.byte_range()];
    let may_be_nothing = ["null", "undefined", "any", "unknown", "void"]
        .iter()
        .any(|word| annotation.contains(word));
    if may_be_nothing || assigns(function.child_by_field_name("body")?, name, source) {
        return None;
    }
    Some(annotation)
}

fn assigns(body: Node, name: &str, source: &str) -> bool {
    let assigned = |node: Node| {
        matches!(
            node.kind(),
            "assignment" | "augmented_assignment" | "assignment_expression" | "augmented_assignment_expression"
        ) && node
            .child_by_field_name("left")
            .is_some_and(|left| &source[left.byte_range()] == name)
    };
    let mut stack = vec![body];
    while let Some(node) = stack.pop() {
        if assigned(node) {
            return true;
        }
        let mut cursor = node.walk();
        stack.extend(node.children(&mut cursor));
    }
    false
}

fn ancestors(node: Node) -> impl Iterator<Item = Node> {
    std::iter::successors(node.parent(), |node| node.parent())
}
