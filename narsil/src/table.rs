//! The chronicle drawn as a table, as wide as the terminal.

use std::env;

use terminal_size::{Width, terminal_size};

use crate::chronicle::{Lighting, NO_KEEPER};
use crate::time;

const BOLD: &str = "\x1b[1m";
const RESET: &str = "\x1b[0m";

fn width() -> usize {
    if let Some((Width(columns), _)) = terminal_size() {
        return columns as usize;
    }
    env::var("COLUMNS")
        .ok()
        .and_then(|columns| columns.parse().ok())
        .unwrap_or(80)
}

fn painted(text: &str, code: &str, color: bool) -> String {
    if color {
        format!("{code}{text}{RESET}")
    } else {
        text.to_string()
    }
}

fn realm_code(realm: &str) -> &'static str {
    match realm {
        "Gondor" => "\x1b[36m",
        "Rohan" => "\x1b[32m",
        _ => "\x1b[33m",
    }
}

fn cut(text: &str, room: usize) -> String {
    if text.chars().count() <= room {
        return text.to_string();
    }
    let mut kept: String = text.chars().take(room.saturating_sub(1)).collect();
    kept.push('…');
    kept
}

fn longest<'a>(header: &str, cells: impl Iterator<Item = &'a str>) -> usize {
    cells
        .map(|cell| cell.chars().count())
        .max()
        .unwrap_or(0)
        .max(header.len())
}

pub fn print(lightings: &[Lighting]) {
    let color = env::var_os("NO_COLOR").is_none();
    let ids: Vec<String> = lightings.iter().map(|l| l.id.to_string()).collect();
    let id = longest("ID", ids.iter().map(String::as_str));
    let beacon = longest("BEACON", lightings.iter().map(|l| l.beacon.as_str()));
    let realm = longest("REALM", lightings.iter().map(|l| l.realm.as_str()));
    let lit_at = longest("LIT AT", lightings.iter().map(|l| l.lit_at.as_str()));
    let keeper = longest("KEEPER", lightings.iter().map(|l| l.keeper.as_deref().unwrap_or(NO_KEEPER)));
    let watchers = "WATCHERS".len();
    // Two spaces between columns; the note takes what is left of the line, and goes when nothing is.
    let taken = id + beacon + realm + lit_at + keeper + watchers + 2 * 6;
    let note = width().saturating_sub(taken);
    let with_note = note >= 4;

    let mut header = format!(
        "{:>id$}  {:<beacon$}  {:<realm$}  {:<lit_at$}  {:<keeper$}  {:>watchers$}",
        "ID", "BEACON", "REALM", "LIT AT", "KEEPER", "WATCHERS"
    );
    if with_note {
        header.push_str("  NOTE");
    }
    println!("{}", painted(&header, BOLD, color));

    for lighting in lightings {
        let realm_cell = format!("{:<realm$}", lighting.realm);
        let mut row = format!(
            "{:>id$}  {:<beacon$}  {}  {:<lit_at$}  {:<keeper$}  {:>watchers$}",
            lighting.id,
            lighting.beacon,
            painted(&realm_cell, realm_code(&lighting.realm), color),
            lighting.lit_at,
            lighting.keeper.as_deref().unwrap_or(NO_KEEPER),
            lighting.watchers,
        );
        if with_note && !lighting.note.is_empty() {
            row.push_str("  ");
            row.push_str(&cut(&lighting.note, note));
        }
        println!("{row}");
    }
    println!("{} lightings, generated at {}", lightings.len(), time::now());
}
