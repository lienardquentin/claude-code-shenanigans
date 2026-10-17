//! What orcrist knows of each language's grammar, one table per language: the rules ask the table of a file's
//! language rather than match on it. A language's own checks, such as how it swallows an error, are written in the
//! rule's module and named here. The rules still take some grammar as given: a call names what it calls in its
//! `function` field, a function its parameters in `parameters`, and a bare name is an `identifier`.

use tree_sitter::Node;

use crate::project::File;
use crate::{impossible, single_use, swallowed};

/// Where, in a node, a name it declares stands.
#[derive(Clone, Copy)]
pub enum Place {
    /// In this field
    Field(&'static str),
    /// It is its first child: `info: str`
    First,
    /// Any child of it is one: Python's `def light(beacon, keeper)`
    Any,
}

/// Where, in a parameter, its name stands.
#[derive(Clone, Copy)]
pub enum Holds {
    /// In this field
    Field(&'static str),
    /// It is its first named child: `info: str`
    First,
    /// It is the parameter itself, a bare name
    Itself,
}

/// A way the code drops an error: the kind of node it is, how to tell, and what to say of it.
pub struct Swallowed {
    pub kind: &'static str,
    pub drops: fn(Node, &str) -> bool,
    pub message: &'static str,
}

/// A guard for what cannot happen: the kind of node it is, and the parameter it checks with the annotation that rules
/// the check out, when it is one.
pub type Guard = (&'static str, for<'a> fn(Node, &'a str) -> Option<(&'a str, &'a str)>);

pub struct Syntax {
    /// Kinds of the nodes that are comments
    pub comments: &'static [&'static str],
    /// Kinds of the nodes that define a function, its name in their `name` field
    pub functions: &'static [&'static str],
    /// Kinds of the nodes that bind a name, their `name`, to a value, their `value`, and the kinds of value that make
    /// that name a function's: `const light = (beacon) => …`
    pub bindings: &'static [&'static str],
    pub function_values: &'static [&'static str],
    /// Where a node of each kind declares a name that is a value's, a variable's or a parameter's
    pub declarations: &'static [(&'static str, Place)],
    /// Where the name stands in a parameter of each kind
    pub parameters: &'static [(&'static str, Holds)],
    /// Names of a method's own receiver, which no call passes
    pub receivers: &'static [&'static str],
    /// Kinds of the nodes that call a function, and of the literals an argument of one can be
    pub calls: &'static [&'static str],
    pub literals: &'static [&'static str],
    /// The name of the interface a node declares: a trait, an abstract class
    pub interface: for<'a> fn(Node, &'a File) -> Option<&'a str>,
    /// The names of the interfaces a node implements
    pub implemented: for<'a> fn(Node, &'a File) -> Vec<&'a str>,
    pub swallowed: &'static [Swallowed],
    pub guards: &'static [Guard],
}

/// Python's receivers, left out in every language as they were before the tables.
const RECEIVERS: &[&str] = &["self", "cls"];

/// What a rule says of an error caught and left there.
const CAUGHT: &str = "the error is caught and nothing is done with it";

pub static RUST: Syntax = Syntax {
    comments: &["line_comment", "block_comment"],
    functions: &["function_item"],
    bindings: &[],
    function_values: &[],
    declarations: &[
        ("let_declaration", Place::Field("pattern")),
        ("parameter", Place::Field("pattern")),
    ],
    parameters: &[("parameter", Holds::Field("pattern"))],
    receivers: RECEIVERS,
    calls: &["call_expression"],
    literals: &[
        "integer_literal",
        "float_literal",
        "string_literal",
        "boolean_literal",
        "char_literal",
    ],
    interface: single_use::rust_interface,
    implemented: single_use::rust_implemented,
    swallowed: &[
        Swallowed {
            kind: "expression_statement",
            drops: swallowed::ok_dropped,
            message: "the error is turned into an Option and dropped",
        },
        Swallowed {
            kind: "let_declaration",
            drops: swallowed::call_bound_to_wildcard,
            message: "what the call returns, an error among it, is bound to _ and dropped",
        },
    ],
    guards: &[],
};

pub static PYTHON: Syntax = Syntax {
    comments: &["comment"],
    functions: &["function_definition"],
    bindings: &[],
    function_values: &[],
    declarations: &[
        ("default_parameter", Place::Field("name")),
        ("typed_default_parameter", Place::Field("name")),
        ("assignment", Place::Field("left")),
        ("parameters", Place::Any),
        ("typed_parameter", Place::First),
    ],
    parameters: &[
        ("identifier", Holds::Itself),
        ("typed_parameter", Holds::First),
        ("default_parameter", Holds::Field("name")),
        ("typed_default_parameter", Holds::Field("name")),
    ],
    receivers: RECEIVERS,
    calls: &["call"],
    literals: &["integer", "float", "string", "true", "false", "none"],
    interface: single_use::python_interface,
    implemented: single_use::python_implemented,
    swallowed: &[Swallowed {
        kind: "except_clause",
        drops: swallowed::only_passes,
        message: CAUGHT,
    }],
    guards: &[
        ("call", impossible::python_isinstance),
        ("comparison_operator", impossible::python_none_check),
    ],
};

/// TypeScript's, which JavaScript, JSX and a Vue component's `<script>` share.
pub static TYPESCRIPT: Syntax = Syntax {
    comments: &["comment"],
    functions: &["function_declaration", "method_definition"],
    bindings: &["variable_declarator"],
    function_values: &["arrow_function", "function_expression"],
    declarations: &[
        ("variable_declarator", Place::Field("name")),
        ("required_parameter", Place::Field("pattern")),
        ("optional_parameter", Place::Field("pattern")),
    ],
    parameters: &[
        ("required_parameter", Holds::Field("pattern")),
        ("optional_parameter", Holds::Field("pattern")),
    ],
    receivers: RECEIVERS,
    calls: &["call_expression"],
    literals: &["number", "string", "true", "false", "null", "undefined"],
    interface: single_use::typescript_interface,
    implemented: single_use::typescript_implemented,
    swallowed: &[
        Swallowed {
            kind: "catch_clause",
            drops: swallowed::catches_nothing,
            message: CAUGHT,
        },
        Swallowed {
            kind: "call_expression",
            drops: swallowed::catches_with_nothing,
            message: CAUGHT,
        },
    ],
    guards: &[
        ("binary_expression", impossible::typescript_comparison),
        ("member_expression", impossible::typescript_optional_chain),
    ],
};
