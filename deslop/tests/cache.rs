//! The findings kept between runs.

mod common;

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use common::{SLUG_OF, folder, git, run, stdout, write};

/// The findings deslop keeps between runs, in the repository's git folder.
fn cache_entries(folder: &Path) -> Vec<PathBuf> {
    fs::read_dir(folder.join(".git/deslop-cache"))
        .map(|entries| entries.map(|entry| entry.unwrap().path()).collect())
        .unwrap_or_default()
}

#[test]
fn a_file_changed_since_the_last_run_is_read_again() {
    let folder = folder("cache-changed");
    git(&folder, &["init", "--quiet"]);
    write(
        &folder,
        &[
            ("names.ts", SLUG_OF),
            ("beacons.ts", &SLUG_OF.replace("slugOf", "beaconId")),
        ],
    );

    let first = run(&folder, &["check", "beacons.ts"]);
    write(&folder, &[("names.ts", "export const realm = 'Gondor'\n")]);
    let second = run(&folder, &["check", "beacons.ts"]);

    assert_eq!(
        stdout(&first),
        "beacons.ts:1 duplicate-helper: beaconId does what slugOf in names.ts:1 already does\n"
    );
    assert!(!cache_entries(&folder).is_empty(), "the findings of names.ts were kept");
    assert_eq!(stdout(&second), "");
    assert_eq!(second.status.code(), Some(0));
}

#[test]
fn kept_findings_that_cannot_be_read_are_found_again() {
    let folder = folder("cache-unreadable");
    git(&folder, &["init", "--quiet"]);
    write(
        &folder,
        &[
            ("names.ts", SLUG_OF),
            ("beacons.ts", &SLUG_OF.replace("slugOf", "beaconId")),
        ],
    );
    run(&folder, &["check", "beacons.ts"]);
    for entry in cache_entries(&folder) {
        fs::write(entry, "not what deslop wrote").unwrap();
    }

    let output = run(&folder, &["check", "beacons.ts"]);

    assert_eq!(
        stdout(&output),
        "beacons.ts:1 duplicate-helper: beaconId does what slugOf in names.ts:1 already does\n"
    );
    assert_eq!(output.status.code(), Some(1));
}

#[test]
fn findings_no_run_used_for_a_week_are_let_go() {
    let folder = folder("cache-pruned");
    git(&folder, &["init", "--quiet"]);
    write(&folder, &[("names.ts", SLUG_OF), ("load.rs", "fn load() {}\n")]);
    run(&folder, &["check", "load.rs"]);
    let kept = cache_entries(&folder);
    let eight_days_ago = std::time::SystemTime::now() - std::time::Duration::from_hours(8 * 24);
    for entry in &kept {
        fs::File::options()
            .write(true)
            .open(entry)
            .unwrap()
            .set_modified(eight_days_ago)
            .unwrap();
    }
    write(&folder, &[("names.ts", "export const realm = 'Gondor'\n")]);

    run(&folder, &["check", "load.rs"]);

    assert_ne!(kept.len(), 0, "the run kept nothing to let go");
    assert!(kept.iter().all(|entry| !entry.exists()), "{kept:?}");
    assert_eq!(
        cache_entries(&folder).len(),
        1,
        "the findings of names.ts as it is now are kept"
    );
}

#[test]
fn only_what_deslop_kept_is_let_go_and_never_through_a_link() {
    let eight_days_ago = std::time::SystemTime::now() - std::time::Duration::from_hours(8 * 24);
    let age = |path: &Path| {
        fs::File::options()
            .write(true)
            .open(path)
            .unwrap()
            .set_modified(eight_days_ago)
            .unwrap();
    };
    let linked = folder("cache-linked");
    git(&linked, &["init", "--quiet"]);
    write(
        &linked,
        &[
            ("names.ts", SLUG_OF),
            ("load.rs", "fn load() {}\n"),
            ("elsewhere/precious.txt", "mine\n"),
            ("elsewhere/0123456789abcdef.json", "{}"),
        ],
    );
    age(&linked.join("elsewhere/precious.txt"));
    age(&linked.join("elsewhere/0123456789abcdef.json"));
    std::os::unix::fs::symlink(linked.join("elsewhere"), linked.join(".git/deslop-cache")).unwrap();
    let foreign = folder("cache-foreign");
    git(&foreign, &["init", "--quiet"]);
    write(
        &foreign,
        &[
            ("names.ts", SLUG_OF),
            ("load.rs", "fn load() {}\n"),
            (".git/deslop-cache/precious.txt", "mine\n"),
        ],
    );
    age(&foreign.join(".git/deslop-cache/precious.txt"));

    let through_link = run(&linked, &["check", "load.rs"]);
    let beside_foreign = run(&foreign, &["check", "load.rs"]);

    assert_eq!(through_link.status.code(), Some(0));
    assert!(linked.join("elsewhere/precious.txt").exists());
    assert!(linked.join("elsewhere/0123456789abcdef.json").exists());
    assert_eq!(
        fs::read_dir(linked.join("elsewhere")).unwrap().count(),
        2,
        "nothing was kept through the link"
    );
    assert_eq!(beside_foreign.status.code(), Some(0));
    assert!(foreign.join(".git/deslop-cache/precious.txt").exists());
}

#[test]
fn a_cache_folder_others_may_read_keeps_nothing() {
    use std::os::unix::fs::PermissionsExt;
    let folder = folder("cache-shared");
    git(&folder, &["init", "--quiet"]);
    write(&folder, &[("names.ts", SLUG_OF), ("load.rs", "fn load() {}\n")]);
    fs::create_dir(folder.join(".git/deslop-cache")).unwrap();
    fs::set_permissions(folder.join(".git/deslop-cache"), fs::Permissions::from_mode(0o755)).unwrap();
    let private = folder.join("private");
    fs::create_dir(&private).unwrap();
    git(&private, &["init", "--quiet"]);
    write(&private, &[("names.ts", SLUG_OF), ("load.rs", "fn load() {}\n")]);

    run(&folder, &["check", "load.rs"]);
    run(&private, &["check", "load.rs"]);

    assert!(
        cache_entries(&folder).is_empty(),
        "nothing is kept where others may read"
    );
    let entries = cache_entries(&private);
    assert_eq!(entries.len(), 1);
    let mode = |path: &Path| fs::metadata(path).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode(&private.join(".git/deslop-cache")), 0o700);
    assert_eq!(mode(&entries[0]), 0o600);
}

#[test]
fn a_run_that_only_reads_kept_findings_leaves_the_cache_folder_untouched() {
    let folder = folder("cache-untouched");
    git(&folder, &["init", "--quiet"]);
    write(
        &folder,
        &[
            ("names.ts", SLUG_OF),
            ("beacons.ts", &SLUG_OF.replace("slugOf", "beaconId")),
        ],
    );
    let cache = folder.join(".git/deslop-cache");

    run(&folder, &["check", "beacons.ts"]);
    assert!(!cache_entries(&folder).is_empty(), "the findings of names.ts were kept");
    let kept = fs::metadata(&cache).unwrap().modified().unwrap();
    let second = run(&folder, &["check", "beacons.ts"]);

    assert_eq!(second.status.code(), Some(1));
    assert_eq!(fs::metadata(&cache).unwrap().modified().unwrap(), kept);
}

#[test]
#[ignore = "needs root: run with sudo cargo test -- --ignored"]
fn a_cache_folder_another_user_owns_keeps_nothing() {
    use std::os::unix::fs::PermissionsExt;
    let uid = Command::new("id").arg("-u").output().unwrap();
    assert_eq!(stdout(&uid).trim(), "0", "this test runs as root");
    let folder = folder("cache-foreign-owner");
    git(&folder, &["init", "--quiet"]);
    write(&folder, &[("names.ts", SLUG_OF), ("load.rs", "fn load() {}\n")]);
    let cache = folder.join(".git/deslop-cache");
    fs::create_dir(&cache).unwrap();
    fs::set_permissions(&cache, fs::Permissions::from_mode(0o700)).unwrap();
    std::os::unix::fs::chown(&cache, Some(65534), None).unwrap();
    let before = fs::metadata(&cache).unwrap().modified().unwrap();

    run(&folder, &["check", "load.rs"]);

    assert!(
        cache_entries(&folder).is_empty(),
        "nothing is kept where another user owns"
    );
    assert_eq!(fs::metadata(&cache).unwrap().modified().unwrap(), before);
}
