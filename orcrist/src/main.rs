mod diff;
mod restating;
mod rules;
mod swallowed;

use std::fs;
use std::path::PathBuf;
use std::process::ExitCode;

use clap::{Parser, Subcommand};

/// Finds what an AI leaves behind in code: comments that restate it, guards for what cannot happen, vague names.
#[derive(Parser)]
#[command(version)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Report the slop in the given files; exits 1 when there is any.
    Check {
        #[arg(required_unless_present = "since", conflicts_with = "since")]
        files: Vec<PathBuf>,
        /// Judge only the lines the working tree added since this commit, in the Rust files git tracks.
        #[arg(long)]
        since: Option<String>,
    },
}

fn main() -> ExitCode {
    let Command::Check { files, since } = Cli::parse().command;
    let targets: Vec<(PathBuf, diff::Added)> = match since {
        Some(since) => match diff::added_lines(&since) {
            Ok(added) => added.into_iter().collect(),
            Err(error) => {
                eprintln!("orcrist: {error}");
                return ExitCode::from(2);
            }
        },
        None => files.into_iter().map(|file| (file, None)).collect(),
    };
    let mut found = false;
    for (file, lines) in targets {
        let source = match fs::read_to_string(&file) {
            Ok(source) => source,
            Err(error) => {
                eprintln!("orcrist: cannot read {}: {error}", file.display());
                return ExitCode::from(2);
            }
        };
        for finding in rules::check(&source) {
            if lines.as_ref().is_some_and(|lines| !lines.contains(&finding.line)) {
                continue;
            }
            println!(
                "{}:{} {}: {}",
                file.display(),
                finding.line,
                finding.rule,
                finding.message
            );
            found = true;
        }
    }
    if found { ExitCode::from(1) } else { ExitCode::SUCCESS }
}
