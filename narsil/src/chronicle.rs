//! The chronicle: a file of lightings, one JSON object to a line.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::time;

/// The beacon-hills of Gondor, from Minas Tirith to the border of Rohan.
pub const BEACONS: [&str; 7] = [
    "Amon Dîn",
    "Eilenach",
    "Nardol",
    "Erelas",
    "Min-Rimmon",
    "Calenhad",
    "Halifirien",
];

const KEEPERS: [&str; 8] = [
    "Beregond", "Ingold", "Hirgon", "Damrod", "Mablung", "Anborn", "Baranor", "Targon",
];

const NOTES: [&str; 6] = [
    "",
    "Lit at the sight of the fire to the east",
    "Wet wood, slow to take",
    "Lit on the Steward's order, with no fire seen",
    "The watch was short of two men",
    "Seen from the next hill within the quarter hour",
];

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Lighting {
    pub id: u64,
    pub beacon: String,
    pub realm: String,
    pub lit_at: String,
    #[serde(default, deserialize_with = "keeper_or_none")]
    pub keeper: Option<String>,
    pub watchers: u32,
    #[serde(default)]
    pub note: String,
}

/// A missing, null or blank keeper is no keeper.
fn keeper_or_none<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<Option<String>, D::Error> {
    let keeper = Option::<String>::deserialize(deserializer)?;
    Ok(keeper.filter(|keeper| !keeper.trim().is_empty()))
}

/// How a lighting with no keeper is spelt where a keeper is expected.
pub const NO_KEEPER: &str = "(no keeper)";

fn said(path: &Path, error: impl std::fmt::Display) -> String {
    format!("{}: {error}", path.display())
}

pub fn read(path: &Path) -> Result<Vec<Lighting>, String> {
    let text = fs::read_to_string(path).map_err(|error| said(path, error))?;
    let mut lightings = Vec::new();
    for (index, line) in text.lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        match serde_json::from_str(line) {
            Ok(lighting) => lightings.push(lighting),
            Err(_) => println!(
                "warning: line {} of {} is not a lighting, skipped",
                index + 1,
                path.display()
            ),
        }
    }
    Ok(lightings)
}

fn line(lighting: &Lighting) -> String {
    serde_json::to_string(lighting).expect("a lighting is always JSON")
}

/// Writes the whole chronicle beside itself first, so a write that fails leaves the old one whole.
pub fn write(path: &Path, lightings: &[Lighting]) -> Result<(), String> {
    let mut text = String::new();
    for lighting in lightings {
        text.push_str(&line(lighting));
        text.push('\n');
    }
    let mut beside = path.as_os_str().to_owned();
    beside.push(".tmp");
    let beside = Path::new(&beside);
    fs::write(beside, text).map_err(|error| said(beside, error))?;
    fs::rename(beside, path).map_err(|error| said(path, error))
}

pub fn append(path: &Path, lighting: &Lighting) -> Result<(), String> {
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|error| said(path, error))?;
    writeln!(file, "{}", line(lighting)).map_err(|error| said(path, error))
}

/// As many lightings as asked for, the same ones for the same seed: what the tests and the timings are run on.
pub fn forge(count: u64, seed: u64) -> Vec<Lighting> {
    let mut state = seed;
    let mut next = |below: u64| {
        state = state
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        (state >> 33) % below
    };
    let mut at = time::days_from_civil(3019, 3, 7) * 86_400;
    (1..=count)
        .map(|id| {
            at += 60 * (1 + next(720)) as i64;
            Lighting {
                id,
                beacon: BEACONS[next(7) as usize].to_string(),
                realm: if next(4) == 0 { "Rohan" } else { "Gondor" }.to_string(),
                lit_at: time::iso(at),
                keeper: Some(KEEPERS[next(8) as usize].to_string()),
                watchers: 4 + next(20) as u32,
                note: NOTES[next(6) as usize].to_string(),
            }
        })
        .collect()
}
