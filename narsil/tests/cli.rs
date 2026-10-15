//! narsil run as a person runs it: the binary, its arguments, and what it wrote and exited with.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

/// A folder of the test's own, which is also the home narsil looks for its config in.
fn home(test: &str) -> PathBuf {
    let home = std::env::temp_dir().join(format!("narsil-{}-{test}", std::process::id()));
    fs::remove_dir_all(&home).ok();
    fs::create_dir_all(&home).unwrap();
    home
}

fn narsil(home: &Path, args: &[&str]) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_narsil"));
    command
        .args(args)
        .current_dir(home)
        .env("HOME", home)
        .env_remove("XDG_CONFIG_HOME")
        .env_remove("NARSIL_CHRONICLE")
        .env("NO_COLOR", "1");
    command
}

fn run(home: &Path, args: &[&str]) -> Output {
    narsil(home, args).output().unwrap()
}

fn stdout(output: &Output) -> String {
    String::from_utf8(output.stdout.clone()).unwrap()
}

fn stderr(output: &Output) -> String {
    String::from_utf8(output.stderr.clone()).unwrap()
}

fn forged(test: &str, count: &str) -> PathBuf {
    let home = home(test);
    assert!(
        run(&home, &["forge", "chronicle.jsonl", "--count", count])
            .status
            .success()
    );
    home
}

#[test]
fn the_same_seed_forges_the_same_chronicle() {
    let home = forged("forge", "50");
    run(&home, &["forge", "again.jsonl", "--count", "50"]);
    run(&home, &["forge", "other.jsonl", "--count", "50", "--seed", "1"]);
    let first = fs::read(home.join("chronicle.jsonl")).unwrap();
    assert_eq!(first, fs::read(home.join("again.jsonl")).unwrap());
    assert_ne!(first, fs::read(home.join("other.jsonl")).unwrap());
}

#[test]
fn forge_does_not_write_over_a_file_unasked() {
    let home = forged("overwrite", "5");
    let output = run(&home, &["forge", "chronicle.jsonl", "--count", "9"]);
    assert_eq!(output.status.code(), Some(1));
    assert!(stderr(&output).contains("--force"));
    assert_eq!(
        fs::read_to_string(home.join("chronicle.jsonl"))
            .unwrap()
            .lines()
            .count(),
        5
    );
}

#[test]
fn ls_as_json_is_every_lighting() {
    let home = forged("ls-json", "25");
    let output = run(&home, &["ls", "--format", "json"]);
    let lightings: serde_json::Value = serde_json::from_str(&stdout(&output)).unwrap();
    assert_eq!(lightings.as_array().unwrap().len(), 25);
    assert_eq!(lightings[0]["id"], 1);
}

#[test]
fn ls_since_a_date_leaves_the_earlier_ones_out() {
    let home = forged("ls-since", "25");
    let output = run(&home, &["ls", "--format", "json", "--since", "3019-03-09"]);
    let lightings: serde_json::Value = serde_json::from_str(&stdout(&output)).unwrap();
    let lightings = lightings.as_array().unwrap();
    assert!(!lightings.is_empty() && lightings.len() < 25);
    assert!(lightings.iter().all(|l| l["lit_at"].as_str().unwrap() >= "3019-03-09"));
}

// sting: narsil ls --until 3019-03-10
#[test]
fn ls_until_a_date_leaves_the_later_ones_out_and_keeps_the_whole_day() {
    let home = forged("ls-until", "25");
    let output = run(&home, &["ls", "--format", "json", "--until", "3019-03-10"]);
    assert!(output.status.success());
    let lightings: serde_json::Value = serde_json::from_str(&stdout(&output)).unwrap();
    let lightings = lightings.as_array().unwrap();
    assert!(!lightings.is_empty() && lightings.len() < 25);
    assert!(lightings.iter().all(|l| l["lit_at"].as_str().unwrap() < "3019-03-11"));
    let all = run(&home, &["ls", "--format", "json"]);
    let all: serde_json::Value = serde_json::from_str(&stdout(&all)).unwrap();
    let on_the_day = all
        .as_array()
        .unwrap()
        .iter()
        .filter(|l| l["lit_at"].as_str().unwrap().starts_with("3019-03-10"))
        .count();
    assert_eq!(
        lightings
            .iter()
            .filter(|l| l["lit_at"].as_str().unwrap().starts_with("3019-03-10"))
            .count(),
        on_the_day
    );
}

#[test]
fn ls_until_a_time_stops_at_that_second() {
    let home = forged("ls-until-time", "25");
    let output = run(&home, &["ls", "--format", "json", "--until", "3019-03-10T06:00:00Z"]);
    let lightings: serde_json::Value = serde_json::from_str(&stdout(&output)).unwrap();
    assert!(
        lightings
            .as_array()
            .unwrap()
            .iter()
            .all(|l| l["lit_at"].as_str().unwrap() <= "3019-03-10T06:00:00Z")
    );
}

#[test]
fn ls_since_and_until_bound_the_lightings_from_both_sides() {
    let home = forged("ls-between", "25");
    let output = run(
        &home,
        &[
            "ls",
            "--format",
            "json",
            "--since",
            "3019-03-09",
            "--until",
            "3019-03-10",
        ],
    );
    let lightings: serde_json::Value = serde_json::from_str(&stdout(&output)).unwrap();
    let lightings = lightings.as_array().unwrap();
    assert!(!lightings.is_empty());
    assert!(lightings.iter().all(|l| {
        let at = l["lit_at"].as_str().unwrap();
        at >= "3019-03-09" && at < "3019-03-11"
    }));
    let output = run(
        &home,
        &[
            "ls",
            "--format",
            "json",
            "--since",
            "3019-03-12",
            "--until",
            "3019-03-10",
        ],
    );
    assert!(output.status.success());
    assert_eq!(stdout(&output).trim(), "[]");
}

#[test]
fn a_date_that_is_not_one_is_refused_for_since_and_until() {
    let home = forged("ls-bad-date", "5");
    for flag in ["--since", "--until"] {
        for bad in ["garbage", "3019-02-30"] {
            let output = run(&home, &["ls", flag, bad]);
            assert_eq!(output.status.code(), Some(1));
            assert_eq!(stdout(&output), "");
            assert_eq!(
                stderr(&output),
                format!("narsil: {flag} \"{bad}\" is not a date; write 3019-03-08 or 3019-03-08T06:00:00Z\n")
            );
        }
    }
}

// sting: narsil show 999
#[test]
fn a_lighting_that_is_not_there_is_said_on_stderr() {
    let home = forged("show-missing", "5");
    let output = run(&home, &["show", "999"]);
    assert_eq!(output.status.code(), Some(1));
    assert_eq!(stdout(&output), "");
    assert_eq!(stderr(&output), "narsil: lighting 999 is not in the chronicle\n");
}

#[test]
fn a_tally_counts_every_lighting_once() {
    let home = forged("tally", "300");
    for by in ["beacon", "keeper", "realm"] {
        let output = run(&home, &["tally", "--by", by, "--format", "json"]);
        let counts: serde_json::Value = serde_json::from_str(&stdout(&output)).unwrap();
        let total: u64 = counts
            .as_array()
            .unwrap()
            .iter()
            .map(|c| c["lightings"].as_u64().unwrap())
            .sum();
        assert_eq!(total, 300, "by {by}");
    }
}

// sting: narsil tally --by keeper
// sting: narsil --chronicle big.jsonl tally
#[test]
fn a_tally_as_a_table_ends_with_the_sum_of_all() {
    let home = forged("tally-all", "300");
    for args in [
        &["tally", "--by", "keeper"][..],
        &["--chronicle", "chronicle.jsonl", "tally"][..],
    ] {
        let output = run(&home, args);
        let table = stdout(&output);
        let last: Vec<&str> = table.lines().last().unwrap().split_whitespace().collect();
        assert_eq!(last[..2], ["ALL", "300"], "{args:?}");
    }
}

#[test]
fn a_seal_holds_until_the_file_changes() {
    let home = forged("seal", "10");
    assert!(run(&home, &["seal", "chronicle.jsonl"]).status.success());
    assert!(run(&home, &["seal", "--check", "chronicle.jsonl"]).status.success());
    fs::OpenOptions::new()
        .append(true)
        .open(home.join("chronicle.jsonl"))
        .unwrap()
        .write_all(b"\n")
        .unwrap();
    assert_eq!(
        run(&home, &["seal", "--check", "chronicle.jsonl"]).status.code(),
        Some(1)
    );
}

#[test]
fn a_dry_prune_writes_nothing() {
    let home = forged("prune", "40");
    let before = fs::read(home.join("chronicle.jsonl")).unwrap();
    let output = run(&home, &["archive", "prune", "--before", "3019-03-10", "--dry-run"]);
    assert!(stdout(&output).starts_with("would take "));
    assert_eq!(before, fs::read(home.join("chronicle.jsonl")).unwrap());

    assert!(
        run(&home, &["archive", "prune", "--before", "3019-03-10"])
            .status
            .success()
    );
    let left = fs::read_to_string(home.join("chronicle.jsonl")).unwrap();
    assert!(left.lines().count() < 40);
    assert!(left.lines().all(|line| line.contains("\"lit_at\":\"3019-03-1")));
}

#[test]
fn the_scribe_asks_again_and_takes_the_keeper_of_the_config() {
    let home = forged("scribe", "3");
    fs::create_dir_all(home.join(".config/narsil")).unwrap();
    fs::write(
        home.join(".config/narsil/config"),
        "# who keeps this hill\nkeeper = Ingold\n",
    )
    .unwrap();
    let mut child = narsil(&home, &["scribe"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    // A hill that is no beacon, then one; a realm; the config's keeper; a number that is none, then one; no note.
    child
        .stdin
        .take()
        .unwrap()
        .write_all(b"Orthanc\nerelas\nRohan\n\nmany\n7\n\n")
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success());
    assert!(stderr(&output).contains("Not a beacon of Gondor"));
    assert_eq!(stdout(&output), "wrote lighting 4 to chronicle.jsonl\n");

    let chronicle = fs::read_to_string(home.join("chronicle.jsonl")).unwrap();
    let last: serde_json::Value = serde_json::from_str(chronicle.lines().last().unwrap()).unwrap();
    assert_eq!(last["beacon"], "Erelas");
    assert_eq!(last["keeper"], "Ingold");
    assert_eq!(last["watchers"], 7);
}

#[test]
fn a_scribe_whose_stdin_ends_writes_nothing() {
    let home = forged("scribe-eof", "3");
    let output = narsil(&home, &["scribe"]).stdin(Stdio::null()).output().unwrap();
    assert_eq!(output.status.code(), Some(1));
    assert_eq!(
        fs::read_to_string(home.join("chronicle.jsonl"))
            .unwrap()
            .lines()
            .count(),
        3
    );
}
