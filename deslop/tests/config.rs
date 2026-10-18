//! The config a project writes: where it is found, what it leaves out, turns off and sets.

mod common;

use std::fs;
use std::path::Path;

use common::{SLUG_OF, folder, git, run, stdout, write};

// pins: deslop check fixtures/configured/load.ts
#[test]
fn deslops_own_config_skips_vague_names_in_the_configured_fixtures() {
    let output = run(
        Path::new(env!("CARGO_MANIFEST_DIR")),
        &["check", "fixtures/configured/load.ts"],
    );

    assert_eq!(
        stdout(&output),
        "fixtures/configured/load.ts:1 restating-comment: the comment says what line 2 already says\n"
    );
    assert_eq!(output.status.code(), Some(1));
}

#[test]
fn the_config_leaves_paths_out_skips_a_rule_where_it_says_and_turns_one_off() {
    let folder = folder("config-ignore-skip-off");
    git(&folder, &["init", "--quiet"]);
    write(
        &folder,
        &[
            (
                "deslop.toml",
                "ignore = [\"dist/**\"]\n\n[rules.duplicate-helper]\nskip = [\"src/kit/*\"]\n\n[rules.vague-name]\noff = true\n",
            ),
            ("dist/bundle.ts", SLUG_OF),
            ("src/kit/slug.ts", SLUG_OF),
            (
                "src/names.ts",
                &format!("{SLUG_OF}\nexport const data = slugOf('Amon Din')\n"),
            ),
        ],
    );

    let names = run(&folder, &["check", "src/names.ts"]);
    let kit = run(&folder, &["check", "src/kit/slug.ts"]);
    let kit_absolute = run(&folder, &["check", folder.join("src/kit/slug.ts").to_str().unwrap()]);

    assert_eq!(
        stdout(&names),
        "src/names.ts:1 duplicate-helper: slugOf does what slugOf in src/kit/slug.ts:1 already does\n"
    );
    assert_eq!(names.status.code(), Some(1));
    assert_eq!(stdout(&kit), "");
    assert_eq!(kit.status.code(), Some(0));
    assert_eq!(stdout(&kit_absolute), "");
    assert_eq!(kit_absolute.status.code(), Some(0));
}

#[test]
fn since_a_commit_what_the_config_ignores_is_neither_judged_nor_named() {
    let folder = folder("config-since-ignore");
    git(&folder, &["init", "--quiet"]);
    write(&folder, &[("deslop.toml", "ignore = [\"dist/**\"]\n")]);
    git(&folder, &["add", "deslop.toml"]);
    git(&folder, &["commit", "--quiet", "-m", "start"]);
    let load = "// read the config file\nconst config = readConfigFile()\n";
    write(
        &folder,
        &[
            ("dist/bundle.ts", load),
            ("dist/app.css", "p {}\n"),
            ("src/load.ts", load),
            ("notes.md", "# Beacons\n"),
        ],
    );

    let output = run(&folder, &["check", "--since", "HEAD"]);

    assert_eq!(
        stdout(&output),
        "src/load.ts:1 restating-comment: the comment says what line 2 already says\n"
    );
    assert_eq!(
        String::from_utf8(output.stderr.clone()).unwrap(),
        "deslop: left unjudged, of no language deslop reads: 1 .md\n"
    );
    assert_eq!(output.status.code(), Some(1));
}

#[test]
fn the_config_is_found_above_the_current_folder_but_not_above_the_repository() {
    let folder = folder("config-above");
    let load = "// read the config file\nconst data = readConfigFile()\n";
    write(
        &folder,
        &[
            ("deslop.toml", "[rules.vague-name]\noff = true\n"),
            (
                "configured/deslop.toml",
                "[rules.restating-comment]\nskip = [\"app/**\"]\n",
            ),
            ("configured/app/load.ts", load),
            ("bare/app/load.ts", load),
        ],
    );
    git(&folder.join("configured"), &["init", "--quiet"]);
    git(&folder.join("bare"), &["init", "--quiet"]);

    let configured = run(&folder.join("configured/app"), &["check", "load.ts"]);
    let bare = run(&folder.join("bare/app"), &["check", "load.ts"]);

    assert_eq!(
        stdout(&configured),
        "load.ts:2 vague-name: data says nothing of what it is\n"
    );
    assert_eq!(configured.status.code(), Some(1));
    assert_eq!(
        stdout(&bare),
        "load.ts:1 restating-comment: the comment says what line 2 already says\n\
         load.ts:2 vague-name: data says nothing of what it is\n"
    );
    assert_eq!(bare.status.code(), Some(1));
}

#[test]
fn outside_a_repository_only_the_current_folder_holds_the_config() {
    let folder = folder("config-outside");
    write(
        &folder,
        &[
            ("deslop.toml", "ignore = [\"**\"]\n\n[rules.vague-name]\noff = true\n"),
            ("app/load.ts", "const data = readConfigFile()\n"),
        ],
    );

    let output = run(&folder.join("app"), &["check", "load.ts"]);

    assert_eq!(
        stdout(&output),
        "load.ts:1 vague-name: data says nothing of what it is\n"
    );
    assert_eq!(output.status.code(), Some(1));
}

#[test]
fn the_config_sets_the_thresholds_and_adds_words() {
    let folder = folder("config-settings");
    write(
        &folder,
        &[
            (
                "deslop.toml",
                "[rules.restating-comment]\nshare = 0.5\nfiller = [\"we\"]\n\n[rules.vague-name]\nwords = [\"Blob\"]\nverbs = [\"execute\"]\n\n[rules.duplicate-helper]\nsmallest = 1000\n\n[rules.single-use-abstraction]\ncalls = 3\n",
            ),
            (
                "beacons.py",
                "def execute(blob, path):\n    # we read the beacons, we do it twice\n    beacons = read_beacons(path)\n    return beacons\n\n\ndef slug_of(name):\n    lowered = name.strip().lower()\n    joined = \"-\".join(lowered.split(\" \"))\n    return joined.replace(\"_\", \"-\")\n\n\ndef beacon_id(title):\n    small = title.strip().lower()\n    dashed = \"-\".join(small.split(\" \"))\n    return dashed.replace(\"_\", \"-\")\n\n\ndef light(beacon, keeper):\n    send(beacon, keeper)\n\n\nlight(\"amon-din\", \"Hirgon\")\nlight(\"eilenach\", \"Hirgon\")\n",
            ),
        ],
    );

    let output = run(&folder, &["check", "beacons.py"]);

    assert_eq!(
        stdout(&output),
        "beacons.py:1 vague-name: execute says nothing of what it is\n\
         beacons.py:1 vague-name: blob says nothing of what it is\n\
         beacons.py:2 restating-comment: the comment says what line 3 already says\n"
    );
    assert_eq!(output.status.code(), Some(1));
}

#[test]
fn a_config_that_says_what_deslop_does_not_understand_is_refused() {
    for (test, config, says) in [
        (
            "config-unknown-rule",
            "[rules.vauge-name]\noff = true\n",
            "no rule is named vauge-name",
        ),
        (
            "config-unknown-key",
            "[rules.vague-name]\nskp = [\"a\"]\n",
            "unknown field `skp`",
        ),
        (
            "config-other-rule",
            "[rules.vague-name]\nshare = 0.5\n",
            "share is restating-comment's to set, not vague-name's",
        ),
        (
            "config-bad-share",
            "[rules.restating-comment]\nshare = 2.0\n",
            "restating-comment's share is 2",
        ),
        ("config-syntax", "[rules.vague-name]\noff = yes\n", "line 2"),
        (
            "config-two-words",
            "[rules.vague-name]\nwords = [\"blobData\"]\n",
            "words holds \"blobData\"",
        ),
        (
            "config-only-digits",
            "[rules.vague-name]\nallow = [\"42\"]\n",
            "allow holds \"42\"",
        ),
        (
            "config-other-rule-out-of-range",
            "[rules.vague-name]\nshare = 2.0\n",
            "share is restating-comment's to set, not vague-name's",
        ),
    ] {
        let folder = folder(test);
        write(&folder, &[("deslop.toml", config), ("load.rs", "fn load() {}\n")]);

        let output = run(&folder, &["check", "load.rs"]);

        let stderr = String::from_utf8(output.stderr.clone()).unwrap();
        assert!(
            stderr.starts_with("deslop: ") && stderr.contains("deslop.toml: ") && stderr.contains(says),
            "{test}: {stderr}"
        );
        assert_eq!(stdout(&output), "", "{test}");
        assert_eq!(output.status.code(), Some(2), "{test}");
    }
}

#[test]
fn since_a_commit_the_config_is_the_one_that_commit_holds() {
    let folder = folder("config-since-base");
    git(&folder, &["init", "--quiet"]);
    write(&folder, &[("load.ts", "export const load = () => 1\n")]);
    git(&folder, &["add", "load.ts"]);
    git(&folder, &["commit", "--quiet", "-m", "start"]);
    write(
        &folder,
        &[
            ("deslop.toml", "[rules.vague-name]\noff = true\n"),
            ("load.ts", "export const load = () => 1\nexport const data = load()\n"),
        ],
    );

    let since = run(&folder, &["check", "--since", "HEAD"]);
    let named = run(&folder, &["check", "load.ts"]);

    // The change cannot turn off the rule that judges it; the working tree's config judges a file named
    assert_eq!(
        stdout(&since),
        "load.ts:2 vague-name: data says nothing of what it is\n"
    );
    assert_eq!(since.status.code(), Some(1));
    assert_eq!(stdout(&named), "");
    assert_eq!(named.status.code(), Some(0));
}

#[test]
fn a_path_given_through_a_link_is_skipped_where_the_config_says() {
    let folder = folder("config-linked-path");
    write(
        &folder,
        &[
            ("deslop.toml", "[rules.vague-name]\nskip = [\"app/**\"]\n"),
            ("app/load.ts", "export const data = 1\n"),
        ],
    );
    let link = folder.with_file_name(format!("{}-link", folder.file_name().unwrap().to_str().unwrap()));
    fs::remove_file(&link).ok(); // deslop: spare swallowed-error: the first run has no link to remove
    std::os::unix::fs::symlink(&folder, &link).unwrap();

    let output = run(&folder, &["check", link.join("app/load.ts").to_str().unwrap()]);

    assert_eq!(stdout(&output), "");
    assert_eq!(output.status.code(), Some(0));
}

#[test]
fn since_a_commit_a_config_error_names_the_file_in_that_commit() {
    let folder = folder("since-config-error");
    git(&folder, &["init", "--quiet"]);
    write(
        &folder,
        &[
            ("deslop.toml", "[rules.vauge-name]\noff = true\n"),
            ("load.rs", "fn load() {}\n"),
        ],
    );
    git(&folder, &["add", "deslop.toml", "load.rs"]);
    git(&folder, &["commit", "--quiet", "-m", "start"]);

    let output = run(&folder, &["check", "--since", "HEAD"]);

    let stderr = String::from_utf8(output.stderr.clone()).unwrap();
    assert!(
        stderr.starts_with("deslop: HEAD:deslop.toml: no rule is named vauge-name"),
        "{stderr}"
    );
    assert_eq!(output.status.code(), Some(2));
}

#[test]
fn a_filler_word_keeps_its_digits() {
    let folder = folder("filler-digits");
    write(
        &folder,
        &[
            ("deslop.toml", "[rules.restating-comment]\nfiller = [\"v2\"]\n"),
            ("load.ts", "// v2 read config\nconst config = readConfig()\n"),
        ],
    );

    let output = run(&folder, &["check", "load.ts"]);

    // With `v2` filler, two of the two words left are in the line below
    assert_eq!(
        stdout(&output),
        "load.ts:1 restating-comment: the comment says what line 2 already says\n"
    );
    assert_eq!(output.status.code(), Some(1));
}

// pins: deslop check --root fixtures/misconfigured load.rs
#[test]
fn a_config_entry_of_two_words_is_refused_and_named_from_the_current_folder() {
    let output = run(
        Path::new(env!("CARGO_MANIFEST_DIR")),
        &["check", "--root", "fixtures/misconfigured", "load.rs"],
    );

    assert_eq!(
        String::from_utf8(output.stderr.clone()).unwrap(),
        "deslop: deslop.toml: vague-name's words holds \"blobData\", where each is one word, as deslop splits names\n"
    );
    assert_eq!(stdout(&output), "");
    assert_eq!(output.status.code(), Some(2));
}

#[test]
fn since_a_commit_from_a_subfolder_the_configs_of_that_commit_are_found() {
    let folder = folder("config-since-subfolder");
    git(&folder, &["init", "--quiet"]);
    write(
        &folder,
        &[
            ("deslop.toml", "[rules.vague-name]\nskip = [\"app/**\"]\n"),
            ("other/deslop.toml", "[rules.vague-name]\noff = true\n"),
            ("app/load.ts", "export const load = () => 1\n"),
            ("other/load.ts", "export const load = () => 1\n"),
        ],
    );
    git(&folder, &["add", "."]);
    git(&folder, &["commit", "--quiet", "-m", "start"]);
    write(
        &folder,
        &[
            (
                "app/load.ts",
                "export const load = () => 1\nexport const data = load()\n",
            ),
            (
                "other/load.ts",
                "export const load = () => 1\nexport const data = load()\n",
            ),
        ],
    );

    let app = run(&folder.join("app"), &["check", "--since", "HEAD"]);
    let other = run(&folder.join("other"), &["check", "--since", "HEAD"]);

    // The root's config, found from `app`, skips it; `other`'s own config turns the rule off there
    assert_eq!(stdout(&app), "");
    assert_eq!(app.status.code(), Some(0), "{}", String::from_utf8_lossy(&app.stderr));
    assert_eq!(stdout(&other), "");
    assert_eq!(
        other.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&other.stderr)
    );
}

#[test]
fn since_a_commit_a_new_bare_git_folder_below_the_root_does_not_hide_the_committed_config() {
    let folder = folder("config-since-bare-git");
    git(&folder, &["init", "--quiet"]);
    write(
        &folder,
        &[
            ("deslop.toml", "[rules.vague-name]\noff = true\n"),
            ("app/sub/load.ts", "export const load = () => 1\n"),
        ],
    );
    git(&folder, &["add", "."]);
    git(&folder, &["commit", "--quiet", "-m", "start"]);
    fs::create_dir_all(folder.join("app/.git")).unwrap();
    write(
        &folder,
        &[(
            "app/sub/load.ts",
            "export const load = () => 1\nexport const data = load()\n",
        )],
    );

    let since = run(&folder.join("app/sub"), &["check", "--since", "HEAD"]);
    let plain = run(&folder.join("app/sub"), &["check", "load.ts"]);

    // Under --since only git's root bounds the search, so the root's committed config turns the rule off
    assert_eq!(stdout(&since), "");
    assert_eq!(
        since.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&since.stderr)
    );
    // Without it the search still stops at app/.git, which holds no config: the defaults report the name
    assert!(stdout(&plain).contains("vague-name"), "{}", stdout(&plain));
    assert_eq!(plain.status.code(), Some(1));
}

#[test]
fn a_config_under_the_old_name_is_read_and_said_to_be_deprecated_where_no_new_one_is_found() {
    let folder = folder("config-old-name");
    write(
        &folder,
        &[
            ("orcrist.toml", "[rules.vague-name]\noff = true\n"),
            ("load.ts", "const data = readConfigFile()\n"),
        ],
    );

    let old = run(&folder, &["check", "load.ts"]);
    write(&folder, &[("deslop.toml", "")]);
    let both = run(&folder, &["check", "load.ts"]);

    assert_eq!(stdout(&old), "");
    assert_eq!(old.status.code(), Some(0));
    assert_eq!(
        String::from_utf8(old.stderr).unwrap(),
        "deslop: orcrist.toml is deprecated, rename it to deslop.toml\n"
    );
    assert_eq!(stdout(&both), "load.ts:1 vague-name: data says nothing of what it is\n");
    assert_eq!(both.stderr, b"");
}
