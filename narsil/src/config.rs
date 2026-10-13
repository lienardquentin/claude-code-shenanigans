//! What narsil is configured with on one machine: `$XDG_CONFIG_HOME/narsil/config`, or `~/.config/narsil/config`.
//! Lines of `key = value`; a line that starts with `#` is a comment.

use std::env;
use std::fs;
use std::path::PathBuf;

#[derive(Default)]
pub struct Config {
    /// The chronicle to work on when neither `--chronicle` nor `NARSIL_CHRONICLE` names one.
    pub chronicle: Option<PathBuf>,
    /// The keeper `scribe` offers when it asks who lit the beacon.
    pub keeper: Option<String>,
}

fn path() -> Option<PathBuf> {
    let base = match env::var_os("XDG_CONFIG_HOME") {
        Some(dir) if !dir.is_empty() => PathBuf::from(dir),
        _ => PathBuf::from(env::var_os("HOME")?).join(".config"),
    };
    Some(base.join("narsil").join("config"))
}

/// A missing file is a config with nothing in it.
pub fn read() -> Config {
    let mut config = Config::default();
    let Some(text) = path().and_then(|path| fs::read_to_string(path).ok()) else {
        return config;
    };
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let value = value.trim();
        match key.trim() {
            "chronicle" => config.chronicle = Some(PathBuf::from(value)),
            "keeper" => config.keeper = Some(value.to_string()),
            _ => {}
        }
    }
    config
}
