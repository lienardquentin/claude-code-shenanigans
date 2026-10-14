//! Sync: what Gondor lit and the chronicle has not heard of, asked of Gondor's GET /lightings and appended.

use std::path::Path;
use std::time::Duration;

use crate::chronicle::{self, Lighting, NO_KEEPER};

/// Gondor is local or reached by a port-forward: one that does not take the call within this is not there.
const CONNECT: Duration = Duration::from_secs(3);
/// How long Gondor may take to start answering, and then to finish: it answers its whole archive at once.
const ANSWER: Duration = Duration::from_secs(10);
const BODY: Duration = Duration::from_secs(30);

/// Asks Gondor at `from` for every lighting it knows.
fn fetch(from: &str) -> Result<Vec<Lighting>, String> {
    // narsil is built without TLS: an https url would only fail later with a muddier error.
    if !from.starts_with("http://") {
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
        .limit(u64::MAX)
        .read_json()
        .map_err(|error| format!("{url}: Gondor's answer is not a list of lightings: {error}"))
}

/// The same beacon, lit at the same time by the same keeper: a lighting the chronicle already holds,
/// whatever id either side gave it.
fn same(a: &Lighting, b: &Lighting) -> bool {
    a.beacon == b.beacon && a.lit_at == b.lit_at && a.keeper == b.keeper
}

pub fn sync(path: &Path, from: &str, dry_run: bool) -> Result<(), String> {
    let gondor = fetch(from)?;
    // A chronicle that is not there yet is one the sync starts.
    let mut known = if path.exists() {
        chronicle::read(path)?
    } else {
        Vec::new()
    };
    let mut next = known.iter().map(|lighting| lighting.id).max().unwrap_or(0) + 1;
    let mut appended = 0;
    for lighting in gondor {
        if known.iter().any(|kept| same(kept, &lighting)) {
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
        known.push(lighting);
    }
    if dry_run {
        println!("would append {appended} lightings from {from} to {}", path.display());
    } else {
        println!("appended {appended} lightings from {from} to {}", path.display());
    }
    Ok(())
}
