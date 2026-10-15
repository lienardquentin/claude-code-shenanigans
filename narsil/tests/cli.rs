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

/// A chronicle of two named lightings and three with no keeper: one missing, one null, one blank.
fn keeperless(test: &str) -> PathBuf {
    let home = home(test);
    fs::write(
        home.join("chronicle.jsonl"),
        concat!(
            r#"{"id":1,"beacon":"Amon Dîn","realm":"Gondor","lit_at":"3019-03-07T07:55:00Z","keeper":"Mablung","watchers":5,"note":""}"#,
            "\n",
            r#"{"id":2,"beacon":"Eilenach","realm":"Gondor","lit_at":"3019-03-07T08:10:00Z","watchers":6,"note":""}"#,
            "\n",
            r#"{"id":3,"beacon":"Nardol","realm":"Gondor","lit_at":"3019-03-07T08:20:00Z","keeper":null,"watchers":7,"note":""}"#,
            "\n",
            r#"{"id":4,"beacon":"Erelas","realm":"Rohan","lit_at":"3019-03-07T08:30:00Z","keeper":"  ","watchers":8,"note":""}"#,
            "\n",
            r#"{"id":5,"beacon":"Calenhad","realm":"Rohan","lit_at":"3019-03-07T08:40:00Z","keeper":"Mablung","watchers":9,"note":""}"#,
            "\n",
        ),
    )
    .unwrap();
    home
}

// sting: narsil tally --by keeper
#[test]
fn a_tally_by_keeper_puts_the_keeperless_in_one_row_of_their_own() {
    let home = keeperless("tally-keeperless");
    let output = run(&home, &["tally", "--by", "keeper"]);
    assert!(output.status.success());
    let table = stdout(&output);
    assert!(!table.contains("warning"), "{table}");
    let rows: Vec<Vec<&str>> = table
        .lines()
        .skip(1)
        .map(|line| {
            line.split("  ")
                .map(str::trim)
                .filter(|cell| !cell.is_empty())
                .collect()
        })
        .collect();
    let nameless: Vec<&Vec<&str>> = rows.iter().filter(|row| row[0] == "(no keeper)").collect();
    assert_eq!(nameless.len(), 1, "{table}");
    assert_eq!(nameless[0][1..], ["3", "21"], "{table}");
    let mablung = rows.iter().find(|row| row[0] == "Mablung").unwrap();
    assert_eq!(mablung[1..], ["2", "14"], "{table}");
    assert_eq!(rows.len(), 3, "{table}");
    assert_eq!(rows.last().unwrap()[..], ["ALL", "5", "35"], "{table}");
}

#[test]
fn a_tally_by_keeper_as_json_names_the_keeperless_null() {
    let home = keeperless("tally-keeperless-json");
    let output = run(&home, &["tally", "--by", "keeper", "--format", "json"]);
    assert!(output.status.success());
    let counts: serde_json::Value = serde_json::from_str(&stdout(&output)).unwrap();
    let counts = counts.as_array().unwrap();
    assert_eq!(counts.len(), 2, "{counts:?}");
    let nameless: Vec<&serde_json::Value> = counts
        .iter()
        .filter(|c| c.as_object().unwrap().get("name") == Some(&serde_json::Value::Null))
        .collect();
    assert_eq!(nameless.len(), 1, "{counts:?}");
    assert_eq!(nameless[0]["lightings"], 3);
    assert_eq!(nameless[0]["watchers"], 21);
    assert!(counts.iter().all(|c| c["name"] != ""), "{counts:?}");
    let mablung = counts.iter().find(|c| c["name"] == "Mablung").unwrap();
    assert_eq!(mablung["lightings"], 2);
}

#[test]
fn ls_as_json_writes_a_missing_null_or_blank_keeper_back_as_null() {
    let home = keeperless("ls-keeperless");
    let output = run(&home, &["ls", "--format", "json"]);
    assert!(output.status.success());
    let lightings: serde_json::Value = serde_json::from_str(&stdout(&output)).unwrap();
    let lightings = lightings.as_array().unwrap();
    assert_eq!(lightings.len(), 5);
    for lighting in &lightings[1..4] {
        assert_eq!(
            lighting.as_object().unwrap().get("keeper"),
            Some(&serde_json::Value::Null),
            "{lighting}"
        );
    }
    assert_eq!(lightings[0]["keeper"], "Mablung");
    assert_eq!(lightings[4]["keeper"], "Mablung");
}

#[test]
fn show_and_ls_say_no_keeper_for_the_keeperless() {
    let home = keeperless("show-keeperless");
    for id in ["2", "3", "4"] {
        let output = run(&home, &["show", id]);
        assert!(output.status.success(), "{id}: {}", stderr(&output));
        let shown = stdout(&output);
        assert!(shown.contains("  Keeper    (no keeper)\n"), "{id}: {shown}");
    }
    let output = run(&home, &["ls"]);
    assert!(output.status.success());
    let table = stdout(&output);
    assert_eq!(table.matches("(no keeper)").count(), 3, "{table}");
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

/// A Gondor of the test's own on 127.0.0.1: it answers each of `times` requests with the same canned response,
/// and gives back the url to sync from.
fn fake_gondor(status: &str, content_type: &str, body: &str, times: usize) -> String {
    use std::io::Read;
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    std::thread::spawn(move || {
        for _ in 0..times {
            let Ok((mut stream, _)) = listener.accept() else {
                return;
            };
            // Read the whole request before answering, so the answer is not cut off by a reset.
            let mut request = Vec::new();
            let mut buffer = [0; 1024];
            while !request.windows(4).any(|w| w == b"\r\n\r\n") {
                match stream.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(read) => request.extend_from_slice(&buffer[..read]),
                }
            }
            stream.write_all(response.as_bytes()).ok();
            stream.flush().ok();
        }
    });
    url
}

/// What Gondor knows, as its /lightings answers, against the keeperless chronicle: two it has (one named, one with
/// no keeper), one it has but for its realm, which does not make a lighting another, and two it has not: one only
/// differing by its keeper from one it has, and one new.
const GONDOR_LIGHTINGS: &str = concat!(
    "[",
    r#"{"id":1,"beacon":"Amon Dîn","realm":"Gondor","lit_at":"3019-03-07T07:55:00Z","keeper":"Mablung","watchers":0,"note":""},"#,
    r#"{"id":2,"beacon":"Nardol","realm":"Gondor","lit_at":"3019-03-07T08:20:00Z","keeper":null,"watchers":0,"note":""},"#,
    r#"{"id":3,"beacon":"Amon Dîn","realm":"Gondor","lit_at":"3019-03-07T07:55:00Z","keeper":"Hirgon","watchers":0,"note":""},"#,
    r#"{"id":4,"beacon":"Halifirien","realm":"Gondor","lit_at":"3019-03-08T06:00:00Z","keeper":null,"watchers":0,"note":""},"#,
    r#"{"id":5,"beacon":"Calenhad","realm":"Gondor","lit_at":"3019-03-07T08:40:00Z","keeper":"Mablung","watchers":0,"note":""}"#,
    "]"
);

/// The last line narsil printed: where it says how many were, or would be, appended.
fn last_line(output: &Output) -> String {
    stdout(output).lines().last().unwrap_or("").to_string()
}

/// One lighting as Gondor would answer it, for a list of its own.
fn one_lighting(beacon: &str, lit_at: &str, keeper: &str) -> String {
    serde_json::json!([{ "id": 1, "beacon": beacon, "realm": "Gondor", "lit_at": lit_at, "keeper": keeper, "watchers": 0, "note": "" }]).to_string()
}

#[test]
fn sync_appends_only_what_the_chronicle_has_not_under_fresh_ids() {
    let home = keeperless("sync");
    let before = fs::read_to_string(home.join("chronicle.jsonl")).unwrap();
    let url = fake_gondor("200 OK", "application/json", GONDOR_LIGHTINGS, 1);
    let output = run(&home, &["sync", "--from", &url]);
    assert!(output.status.success(), "{}", stderr(&output));
    let said = stdout(&output);
    assert!(said.contains("Gondor's lighting 3 is written as 6"), "{said}");
    assert!(said.contains("Gondor's lighting 4 is written as 7"), "{said}");
    assert!(!said.contains("lighting 5"), "{said}");
    assert!(last_line(&output).starts_with(&format!("appended 2 lightings from {url} to ")), "{said}");

    let after = fs::read_to_string(home.join("chronicle.jsonl")).unwrap();
    assert!(after.starts_with(&before), "{after}");
    let added: Vec<serde_json::Value> = after[before.len()..]
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(added.len(), 2, "{after}");
    // The same beacon at the same time by another keeper is another lighting
    assert_eq!(added[0]["id"], 6);
    assert_eq!(added[0]["beacon"], "Amon Dîn");
    assert_eq!(added[0]["lit_at"], "3019-03-07T07:55:00Z");
    assert_eq!(added[0]["keeper"], "Hirgon");
    assert_eq!(added[1]["id"], 7);
    assert_eq!(added[1]["beacon"], "Halifirien");
    assert_eq!(added[1].as_object().unwrap().get("keeper"), Some(&serde_json::Value::Null));
}

#[test]
fn a_second_sync_appends_nothing() {
    let home = keeperless("sync-twice");
    let url = fake_gondor("200 OK", "application/json", GONDOR_LIGHTINGS, 2);
    assert!(run(&home, &["sync", "--from", &url]).status.success());
    let once = fs::read(home.join("chronicle.jsonl")).unwrap();
    let output = run(&home, &["sync", "--from", &url]);
    assert!(output.status.success(), "{}", stderr(&output));
    assert_eq!(once, fs::read(home.join("chronicle.jsonl")).unwrap());
    assert!(!stdout(&output).contains("is written as"), "{}", stdout(&output));
    assert!(last_line(&output).starts_with(&format!("appended 0 lightings from {url} to ")), "{}", stdout(&output));
}

#[test]
fn a_dry_sync_says_what_it_would_append_and_writes_nothing() {
    let home = keeperless("sync-dry");
    let before = fs::read(home.join("chronicle.jsonl")).unwrap();
    let url = fake_gondor("200 OK", "application/json", GONDOR_LIGHTINGS, 1);
    let output = run(&home, &["sync", "--from", &url, "--dry-run"]);
    assert!(output.status.success(), "{}", stderr(&output));
    assert_eq!(before, fs::read(home.join("chronicle.jsonl")).unwrap());
    let said = stdout(&output);
    assert!(said.contains("Gondor's lighting 3 would be written as 6"), "{said}");
    assert!(said.contains("would append lighting 6: Amon Dîn lit at 3019-03-07T07:55:00Z by Hirgon"), "{said}");
    assert!(said.contains("would append lighting 7: Halifirien lit at 3019-03-08T06:00:00Z by (no keeper)"), "{said}");
    assert!(!said.contains("Calenhad"), "{said}");
    assert!(last_line(&output).starts_with(&format!("would append 2 lightings from {url} to ")), "{said}");
}

#[test]
fn a_sync_into_a_missing_chronicle_starts_it() {
    let home = home("sync-new");
    let url = fake_gondor("200 OK", "application/json", GONDOR_LIGHTINGS, 1);
    let output = run(&home, &["sync", "--from", &url]);
    assert!(output.status.success(), "{}", stderr(&output));
    let chronicle = fs::read_to_string(home.join("chronicle.jsonl")).unwrap();
    let ids: Vec<u64> = chronicle
        .lines()
        .map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap()["id"].as_u64().unwrap())
        .collect();
    assert_eq!(ids, [1, 2, 3, 4, 5], "{chronicle}");
}

// sting: narsil sync --from http://127.0.0.1:9 --dry-run
#[test]
fn a_gondor_that_does_not_answer_fails_quickly_and_says_so() {
    let home = keeperless("sync-closed");
    let before = fs::read(home.join("chronicle.jsonl")).unwrap();
    // The run Anduril keeps: the discard port, where nothing on a machine of ours listens
    let started = std::time::Instant::now();
    let output = run(&home, &["sync", "--from", "http://127.0.0.1:9", "--dry-run"]);
    assert!(started.elapsed() < std::time::Duration::from_secs(10), "{:?}", started.elapsed());
    assert!(output.status.code().is_some_and(|code| code != 0), "{}", stdout(&output));
    assert!(stderr(&output).starts_with("narsil: "), "{}", stderr(&output));
    assert!(stderr(&output).trim().len() > "narsil:".len(), "{}", stderr(&output));
    assert_eq!(before, fs::read(home.join("chronicle.jsonl")).unwrap());
}

#[test]
fn a_gondor_that_answers_amiss_is_an_error() {
    for (test, status, content_type, body) in [
        ("sync-500", "500 Internal Server Error", "application/json", r#"{"detail":"the archives are down"}"#),
        ("sync-garbage", "200 OK", "text/html", "<html>no lightings here</html>"),
    ] {
        let home = keeperless(test);
        let before = fs::read(home.join("chronicle.jsonl")).unwrap();
        let url = fake_gondor(status, content_type, body, 1);
        let output = run(&home, &["sync", "--from", &url]);
        assert!(output.status.code().is_some_and(|code| code != 0), "{test}: {}", stdout(&output));
        assert!(stderr(&output).starts_with("narsil: "), "{test}: {}", stderr(&output));
        assert_eq!(before, fs::read(home.join("chronicle.jsonl")).unwrap(), "{test}");
    }
}

#[test]
fn a_lighting_narsil_could_not_print_safely_is_refused_and_none_is_written() {
    for (test, body, why) in [
        ("sync-escape", one_lighting("Amon Dîn", "3019-03-07T07:55:00Z", "Hirgon\u{1b}[2J"), "its keeper holds a control character"),
        ("sync-line", one_lighting("Amon Dîn\nNardol", "3019-03-07T07:55:00Z", "Hirgon"), "its beacon holds a control character"),
        ("sync-bidi", one_lighting("Amon Dîn", "3019-03-07T07:55:00Z", "Hirgon\u{202e}nogriH"), "its keeper holds a control character"),
        ("sync-time", one_lighting("Amon Dîn", "yesterday", "Hirgon"), r#"its lit_at, "yesterday", is not a time"#),
    ] {
        let home = keeperless(test);
        let before = fs::read(home.join("chronicle.jsonl")).unwrap();
        let url = fake_gondor("200 OK", "application/json", &body, 1);
        let output = run(&home, &["sync", "--from", &url]);
        assert_eq!(output.status.code(), Some(1), "{test}: {}", stdout(&output));
        assert!(stderr(&output).contains(&format!("Gondor's lighting 1 is not written: {why}")), "{test}: {}", stderr(&output));
        assert_eq!(before, fs::read(home.join("chronicle.jsonl")).unwrap(), "{test}");
    }
}

#[test]
fn a_gondor_named_in_capitals_is_still_plain_http() {
    let home = keeperless("sync-capitals");
    let url = fake_gondor("200 OK", "application/json", GONDOR_LIGHTINGS, 1).replacen("http://", "HTTP://", 1);
    let output = run(&home, &["sync", "--from", &url, "--dry-run"]);
    assert!(output.status.success(), "{}", stderr(&output));
    let refused = run(&home, &["sync", "--from", "https://127.0.0.1:8101"]);
    assert!(stderr(&refused).contains("plain http only"), "{}", stderr(&refused));
}

#[test]
fn the_bash_completions_know_sync() {
    let kept = fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("completions/narsil.bash")).unwrap();
    assert!(kept.contains("narsil__subcmd__sync"), "the kept completions do not know sync");
    let output = run(&home("completions"), &["completions", "bash"]);
    assert_eq!(stdout(&output), kept, "the kept completions are not what narsil prints");
}
