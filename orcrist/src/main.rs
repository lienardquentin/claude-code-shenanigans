mod diff;
mod duplicate;
mod git;
mod impossible;
mod lang;
mod parallel;
mod project;
mod restating;
mod rules;
mod single_use;
mod swallowed;
mod vague;
mod words;

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::process::ExitCode;

use clap::{Parser, Subcommand};

use lang::Language;
use project::Project;

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
        /// Judge only the lines the working tree added since this commit, in the files of the languages orcrist reads.
        #[arg(long)]
        since: Option<String>,
    },
}

fn main() -> ExitCode {
    let Command::Check { files, since } = Cli::parse().command;
    let targets: Vec<(PathBuf, diff::Added)> = match since {
        Some(since) => match diff::added_lines(&since).and_then(|added| Ok((added, diff::unread(&since)?))) {
            Ok((added, unread)) => {
                if !unread.is_empty() {
                    eprintln!(
                        "orcrist: left unjudged, of no language orcrist reads: {}",
                        kinds(&unread)
                    );
                }
                added.into_iter().collect()
            }
            Err(error) => {
                eprintln!("orcrist: {error}");
                return ExitCode::from(2);
            }
        },
        None => files.into_iter().map(|file| (file, None)).collect(),
    };
    let judged: Vec<PathBuf> = targets.iter().map(|(file, _)| file.clone()).collect();
    if let Some(file) = judged.iter().find(|file| Language::of(file).is_none()) {
        eprintln!(
            "orcrist: no language orcrist reads has the extension of {}",
            file.display()
        );
        return ExitCode::from(2);
    }
    let project = match Project::load(&judged) {
        Ok(project) => project,
        Err(error) => {
            eprintln!("orcrist: {error}");
            return ExitCode::from(2);
        }
    };
    let indexes = rules::index(&project);
    let findings = parallel::map(&targets, |(path, _)| {
        let file = project
            .file(path)
            .expect("every file judged is loaded into the project");
        rules::check(file, &indexes)
    });
    let mut found = false;
    for ((path, lines), findings) in targets.iter().zip(findings) {
        for finding in findings {
            if lines.as_ref().is_some_and(|lines| !lines.contains(&finding.line)) {
                continue;
            }
            println!(
                "{}:{} {}: {}",
                path.display(),
                finding.line,
                finding.rule,
                finding.message
            );
            found = true;
        }
    }
    if found { ExitCode::from(1) } else { ExitCode::SUCCESS }
}

/// How many of `files` there are of each extension, as in `2 .md, 1 .json, 1 Makefile`: a file without one by its name.
fn kinds(files: &[PathBuf]) -> String {
    let mut counts: BTreeMap<String, usize> = BTreeMap::new();
    for file in files {
        let kind = match file.extension() {
            Some(extension) => format!(".{}", extension.to_string_lossy()),
            None => file
                .file_name()
                .expect("git lists files, never a path ending in ..")
                .to_string_lossy()
                .into_owned(),
        };
        *counts.entry(kind).or_default() += 1;
    }
    counts
        .iter()
        .map(|(kind, count)| format!("{count} {kind}"))
        .collect::<Vec<_>>()
        .join(", ")
}
