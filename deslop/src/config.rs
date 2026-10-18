//! What a project tells deslop in its `deslop.toml`: the paths it leaves out, the rules it turns off or skips where,
//! and the thresholds and words the rules judge by. Without one, every rule judges everywhere by its defaults.

use std::collections::BTreeMap;
use std::env;
use std::fs;
use std::path::{Component, Path, PathBuf};

use globset::{Glob, GlobBuilder, GlobSet, GlobSetBuilder};
use serde::Deserialize;

use crate::rules::RULES;
use crate::words::words;
use crate::{duplicate, git, restating, single_use};

/// The name of the file deslop looks for, in the current folder and each folder above it up to the repository's root.
pub const FILE_NAME: &str = "deslop.toml";

/// The name the file went by before, still read where there is no `deslop.toml`.
const OLD_FILE_NAME: &str = "orcrist.toml";

/// The thresholds and words the rules judge by: their defaults, with what the config sets or adds.
pub struct Settings {
    /// Share of a comment's meaningful words found in the code below that makes it a restatement
    pub restated_share: f64,
    /// Filler words a comment may hold besides the built-in ones
    pub filler: Vec<String>,
    /// Vague words besides the built-in ones
    pub vague_words: Vec<String>,
    /// Vague verbs, for a function's name, besides the built-in ones
    pub vague_verbs: Vec<String>,
    /// Built-in vague words and verbs a project's code means, as a library whose API speaks of `data`
    pub vague_allowed: Vec<String>,
    /// Pieces of code below which two functions alike are alike by chance
    pub smallest: usize,
    /// How many calls `single-use-abstraction` needs before it judges a parameter
    pub calls: usize,
}

impl Default for Settings {
    fn default() -> Settings {
        Settings {
            restated_share: restating::RESTATED_SHARE,
            filler: Vec::new(),
            vague_words: Vec::new(),
            vague_verbs: Vec::new(),
            vague_allowed: Vec::new(),
            smallest: duplicate::SMALLEST,
            calls: single_use::CALLS,
        }
    }
}

#[derive(Default)]
pub struct Config {
    pub settings: Settings,
    /// The folder of the config, which its globs are relative to, and the current folder
    folders: Option<(PathBuf, PathBuf)>,
    ignore: GlobSet,
    off: Vec<String>,
    skip: BTreeMap<String, GlobSet>,
}

#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
struct Written {
    #[serde(default)]
    ignore: Vec<String>,
    #[serde(default)]
    rules: BTreeMap<String, WrittenRule>,
}

#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
struct WrittenRule {
    #[serde(default)]
    off: bool,
    #[serde(default)]
    skip: Vec<String>,
    share: Option<f64>,
    filler: Option<Vec<String>>,
    words: Option<Vec<String>>,
    verbs: Option<Vec<String>>,
    allow: Option<Vec<String>>,
    smallest: Option<usize>,
    calls: Option<usize>,
}

impl Config {
    /// The config of the first folder from the current one up that holds an `deslop.toml`, going no higher than the
    /// repository's root as git tells it, or only the current folder outside a repository; the defaults when there is
    /// none. Without `since` the search also stops at a folder holding its own `.git`. Judging a change `since` a
    /// commit, it is the config as that commit holds it, which the change cannot loosen to pass its own check.
    pub fn find(since: Option<&str>) -> Result<Config, String> {
        let current = env::current_dir().map_err(|error| format!("cannot tell the current folder: {error}"))?;
        // Where it really is, as git names the root: a folder reached through a link is below it all the same
        let current = fs::canonicalize(&current).unwrap_or(current);
        // Outside a repository any folder above may be another's to write in
        let root = git::inside_repository()
            .then(|| git::git(&["rev-parse", "--show-toplevel"]))
            .transpose()?
            .map(|root| PathBuf::from(root.trim()));
        if since.is_some() && root.is_none() {
            return Err("--since judges a change in a git repository, and this folder is in none".to_string());
        }
        // A commit, or a tree as git's empty one, that git does not know is said so, not taken for one without a config
        let since = since
            .map(|since| {
                let tree = format!("{since}^{{tree}}");
                git::git(&["rev-parse", "--verify", "--quiet", "--end-of-options", &tree]).map(|_| since)
            })
            .transpose()
            .map_err(|error| {
                if error.starts_with("cannot run git") {
                    error
                } else {
                    format!("{} is no commit git knows", since.unwrap_or_default())
                }
            })?;
        for folder in current.ancestors() {
            for name in [FILE_NAME, OLD_FILE_NAME] {
                let Some((text, read)) = text_of(name, folder, &current, since, root.as_deref())? else {
                    continue;
                };
                if name == OLD_FILE_NAME {
                    eprintln!("deslop: {read} is deprecated, rename it to {FILE_NAME}");
                }
                // Its errors name the file read: the one in the commit under `--since`
                return Config::parse(&text, (folder.to_path_buf(), current.clone()))
                    .map_err(|error| format!("{read}: {error}"));
            }
            // No higher than the repository's root, nor than the current folder where it is not below the root git
            // names, nor, without `--since`, than a folder holding a `.git`: a change can add one under `--since`
            let last = root
                .as_deref()
                .is_none_or(|root| folder == root || !folder.starts_with(root))
                || (since.is_none() && folder.join(".git").exists());
            if last {
                break;
            }
        }
        Ok(Config::default())
    }

    fn parse(text: &str, folders: (PathBuf, PathBuf)) -> Result<Config, String> {
        // toml's own words, where in the file and what is wrong there
        let written: Written = toml::from_str(text).map_err(|error| error.to_string().trim_end().to_string())?;
        let mut config = Config {
            folders: Some(folders),
            ignore: globs(&written.ignore)?,
            ..Config::default()
        };
        for (rule, written) in written.rules {
            if !RULES.iter().any(|(name, _)| *name == rule) {
                let names: Vec<&str> = RULES.iter().map(|(name, _)| *name).collect();
                return Err(format!("no rule is named {rule}; the rules are {}", names.join(", ")));
            }
            let owners = [
                ("share", written.share.is_some(), "restating-comment"),
                ("filler", written.filler.is_some(), "restating-comment"),
                ("words", written.words.is_some(), "vague-name"),
                ("verbs", written.verbs.is_some(), "vague-name"),
                ("allow", written.allow.is_some(), "vague-name"),
                ("smallest", written.smallest.is_some(), "duplicate-helper"),
                ("calls", written.calls.is_some(), "single-use-abstraction"),
            ];
            if let Some((key, _, owner)) = owners.iter().find(|(_, set, owner)| *set && *owner != rule) {
                return Err(format!("{key} is {owner}'s to set, not {rule}'s"));
            }
            let settings = &mut config.settings;
            // A vague word's digits left off, as they are off a name's words when judged: `tmp2` is `tmp`
            let one_word_each = |key: &str, given: Vec<String>| -> Result<Vec<String>, String> {
                let digits_off = key != "filler";
                given
                    .into_iter()
                    .map(|word| match words(&word)[..] {
                        [ref one] if !digits_off => Ok(one.clone()),
                        [ref one] if !one.trim_end_matches(|digit: char| digit.is_ascii_digit()).is_empty() => {
                            Ok(one.trim_end_matches(|digit: char| digit.is_ascii_digit()).to_string())
                        }
                        _ => Err(format!(
                            "{rule}'s {key} holds {word:?}, where each is one word, as deslop splits names"
                        )),
                    })
                    .collect()
            };
            if let Some(share) = written.share {
                if !(share > 0.0 && share <= 1.0) {
                    return Err(format!(
                        "{rule}'s share is {share}, where it is a share above 0 and at most 1"
                    ));
                }
                settings.restated_share = share;
            }
            if let Some(filler) = written.filler {
                settings.filler = one_word_each("filler", filler)?;
            }
            if let Some(vague) = written.words {
                settings.vague_words = one_word_each("words", vague)?;
            }
            if let Some(verbs) = written.verbs {
                settings.vague_verbs = one_word_each("verbs", verbs)?;
            }
            if let Some(allowed) = written.allow {
                settings.vague_allowed = one_word_each("allow", allowed)?;
            }
            if let Some(smallest) = written.smallest {
                if smallest == 0 {
                    return Err(format!("{rule}'s smallest is 0, where it is a count of pieces of code"));
                }
                settings.smallest = smallest;
            }
            if let Some(calls) = written.calls {
                if calls < 2 {
                    return Err(format!(
                        "{rule}'s calls is {calls}, where every call passing one value takes two"
                    ));
                }
                settings.calls = calls;
            }
            if written.off {
                config.off.push(rule.clone());
            }
            config.skip.insert(rule, globs(&written.skip)?);
        }
        Ok(config)
    }

    /// Whether `path`, relative to the current folder, is one the config leaves out of the project.
    pub fn ignores(&self, path: &Path) -> bool {
        self.within(path).is_some_and(|path| self.ignore.is_match(path))
    }

    /// Whether a finding of `rule` in `path`, relative to the current folder, is reported.
    pub fn reports(&self, rule: &str, path: &Path) -> bool {
        if self.off.iter().any(|off| off == rule) {
            return false;
        }
        let skipped = self.skip.get(rule).zip(self.within(path));
        !skipped.is_some_and(|(skip, path)| skip.is_match(path))
    }

    /// `path`, relative to the current folder or absolute, as the config's globs read it: relative to the config's
    /// folder. None with no config, or for a path outside its folder.
    fn within(&self, path: &Path) -> Option<PathBuf> {
        let (folder, current) = self.folders.as_ref()?;
        let mut absolute = PathBuf::new();
        for component in current.join(path).components() {
            match component {
                Component::ParentDir => {
                    absolute.pop();
                }
                Component::CurDir => {}
                component => absolute.push(component),
            }
        }
        if let Ok(within) = absolute.strip_prefix(folder) {
            return Some(within.to_path_buf());
        }
        // An absolute path through a link, `/tmp/…` where `/tmp` leads elsewhere: where it leads
        let resolved = fs::canonicalize(&absolute).ok()?;
        resolved.strip_prefix(folder).ok().map(Path::to_path_buf)
    }
}

/// The text of the config file `name` in `folder`, and how to name it in an error, if there is one: as the commit
/// `since` holds it when judging a change, else as the working tree does. `current` is the folder it is judged from.
fn text_of(
    name: &str,
    folder: &Path,
    current: &Path,
    since: Option<&str>,
    root: Option<&Path>,
) -> Result<Option<(String, String)>, String> {
    let path = folder.join(name);
    match (since, root) {
        (Some(since), Some(root)) => {
            let in_commit = path
                .strip_prefix(root)
                .map_err(|_| format!("{} is outside the repository at {}", path.display(), root.display()))?
                .to_string_lossy()
                .replace('\\', "/");
            // Listed when the commit holds a config at this path, nothing listed when not; git failing is said
            let listed = git::git(&[
                "ls-tree",
                "--full-tree",
                "--name-only",
                "--end-of-options",
                since,
                "--",
                &in_commit,
            ])?;
            if listed.trim().is_empty() {
                Ok(None)
            } else {
                let at = format!("{since}:{in_commit}");
                Ok(Some((git::git(&["show", "--end-of-options", &at])?, at)))
            }
        }
        _ if path.is_file() => Ok(Some((
            fs::read_to_string(&path).map_err(|error| format!("cannot read {}: {error}", path.display()))?,
            // From the current folder: `deslop.toml`, `../deslop.toml`
            "../".repeat(current.components().count() - folder.components().count()) + name,
        ))),
        _ => Ok(None),
    }
}

/// The globs a config gives, `*` not crossing a `/` as in a `.gitignore`, `**` crossing any number.
fn globs(patterns: &[String]) -> Result<GlobSet, String> {
    let mut set = GlobSetBuilder::new();
    for pattern in patterns {
        let glob: Glob = GlobBuilder::new(pattern)
            .literal_separator(true)
            .build()
            .map_err(|error| error.to_string())?;
        set.add(glob);
    }
    set.build().map_err(|error| error.to_string())
}
