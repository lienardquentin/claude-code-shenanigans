//! Sync: what Gondor lit and the chronicle has not heard of, asked of Gondor's GET /lightings and appended.

use std::collections::HashSet;
use std::path::Path;
use std::time::Duration;

use crate::chronicle::{self, Lighting, NO_KEEPER};

/// Gondor is local or reached by a port-forward: one that does not take the call within this is not there.
const CONNECT: Duration = Duration::from_secs(3);
/// How long Gondor may take to start answering, and then to finish: it answers its whole archive at once.
const ANSWER: Duration = Duration::from_secs(10);
const BODY: Duration = Duration::from_secs(30);
/// The most of Gondor's answer narsil reads: a whole archive, and not a stream that never ends.
const LARGEST: u64 = 64 * 1024 * 1024;

/// Asks Gondor at `from` for every lighting it knows.
fn fetch(from: &str) -> Result<Vec<Lighting>, String> {
    // narsil is built without TLS: an https url would only fail later with a muddier error.
    if !from.get(..7).is_some_and(|scheme| scheme.eq_ignore_ascii_case("http://")) {
        return Err(format!("{from}: narsil syncs over plain http only, as http://host:port"));
    }
    let url = format!("{}/lightings", from.trim_end_matches('/'));
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_connect(Some(CONNECT))
        .timeout_recv_response(Some(ANSWER))
        .timeout_recv_body(Some(BODY))
        .http_status_as_error(false)
        .build()
        .into();
    let mut response = agent
        .get(&url)
        .call()
        .map_err(|error| format!("{url}: Gondor did not answer: {error}"))?;
    let status = response.status();
    if status != 200 {
        return Err(format!("{url}: Gondor answered {status}"));
    }
    response
        .body_mut()
        .with_config()
        .limit(LARGEST)
        .read_json()
        .map_err(|error| format!("{url}: Gondor's answer is not a list of lightings: {error}"))
}

/// A time as Gondor writes one, RFC 3339: 3019-03-07T08:40:00Z, 2026-10-14T09:12:03.481Z, or with an offset.
fn is_time(text: &str) -> bool {
    let bytes = text.as_bytes();
    let digits = |at: std::ops::Range<usize>| bytes.get(at).is_some_and(|run| run.iter().all(u8::is_ascii_digit));
    let at = |index: usize, byte: u8| bytes.get(index) == Some(&byte);
    if !(digits(0..4) && at(4, b'-') && digits(5..7) && at(7, b'-') && digits(8..10) && at(10, b'T')) {
        return false;
    }
    if !(digits(11..13) && at(13, b':') && digits(14..16) && at(16, b':') && digits(17..19)) {
        return false;
    }
    let mut rest = &text[19..];
    if let Some(fraction) = rest.strip_prefix('.') {
        let shown = fraction.bytes().take_while(u8::is_ascii_digit).count();
        if shown == 0 {
            return false;
        }
        rest = &fraction[shown..];
    }
    let zone = rest.as_bytes();
    rest == "Z"
        || (zone.len() == 6
            && (zone[0] == b'+' || zone[0] == b'-')
            && zone[1..3].iter().all(u8::is_ascii_digit)
            && zone[3] == b':'
            && zone[4..6].iter().all(u8::is_ascii_digit))
}

/// What would break a printed line or turn it around: a control character, a line or paragraph separator, a mark
/// that reorders bidirectional text. The set Gondor refuses in a keeper.
fn is_unprintable(character: char) -> bool {
    character.is_control()
        || matches!(character, '\u{2028}' | '\u{2029}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}')
}

/// Why narsil will not write a lighting as Gondor answered it: what it would print later must be text, and when a
/// time. Gondor refuses a keeper with a control character; another server need not.
fn unwritable(lighting: &Lighting) -> Option<String> {
    let fields = [("beacon", Some(&lighting.beacon)), ("realm", Some(&lighting.realm)), ("keeper", lighting.keeper.as_ref()), ("note", Some(&lighting.note))];
    for (name, value) in fields {
        if value.is_some_and(|text| text.chars().any(is_unprintable)) {
            return Some(format!("its {name} holds a control character"));
        }
    }
    if !is_time(&lighting.lit_at) {
        return Some(format!("its lit_at, {:?}, is not a time", lighting.lit_at));
    }
    None
}

/// What makes a lighting the same one: the same beacon, lit at the same time by the same keeper, whatever id either
/// side gave it. The realm is not of it: the person decided so.
fn sameness(lighting: &Lighting) -> (String, String, Option<String>) {
    (lighting.beacon.clone(), lighting.lit_at.clone(), lighting.keeper.clone())
}

pub fn sync(path: &Path, from: &str, dry_run: bool) -> Result<(), String> {
    let gondor = fetch(from)?;
    // The whole answer is looked at before anything is written: one bad lighting and none is.
    if let Some((id, why)) = gondor.iter().find_map(|lighting| unwritable(lighting).map(|why| (lighting.id, why))) {
        return Err(format!("{from}: Gondor's lighting {id} is not written: {why}"));
    }
    // A chronicle that is not there yet is one the sync starts.
    let held = if path.exists() {
        chronicle::read(path)?
    } else {
        Vec::new()
    };
    let mut next = held.iter().map(|lighting| lighting.id).max().unwrap_or(0) + 1;
    let mut known: HashSet<_> = held.iter().map(sameness).collect();
    let mut appended = 0;
    for lighting in gondor {
        // A lighting Gondor answers twice is written once
        if !known.insert(sameness(&lighting)) {
            continue;
        }
        let theirs = lighting.id;
        let lighting = Lighting { id: next, ..lighting };
        next += 1;
        if theirs != lighting.id {
            let be = if dry_run { "would be" } else { "is" };
            println!("Gondor's lighting {theirs} {be} written as {}", lighting.id);
        }
        if dry_run {
            println!(
                "would append lighting {}: {} lit at {} by {}",
                lighting.id,
                lighting.beacon,
                lighting.lit_at,
                lighting.keeper.as_deref().unwrap_or(NO_KEEPER)
            );
        } else {
            chronicle::append(path, &lighting)?;
        }
        appended += 1;
    }
    if dry_run {
        println!("would append {appended} lightings from {from} to {}", path.display());
    } else {
        println!("appended {appended} lightings from {from} to {}", path.display());
    }
    Ok(())
}
