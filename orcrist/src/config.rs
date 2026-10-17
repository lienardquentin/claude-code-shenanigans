//! What a project tells orcrist in its `orcrist.toml`: the paths it leaves out, the rules it turns off or skips where,
//! and the thresholds and words the rules judge by. Without one, every rule judges everywhere by its defaults.

use std::collections::BTreeMap;
use std::env;
use std::fs;
use std::path::{Component, Path, PathBuf};

use globset::{Glob, GlobBuilder, GlobSet, GlobSetBuilder};
use serde::Deserialize;

use crate::rules::RULES;
use crate::{duplicate, git, restating, single_use};

/// The name of the file orcrist looks for, in the current folder and each folder above it up to the repository's root.
pub const FILE_NAME: &str = "orcrist.toml";

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
    /// Pieces of code below which two functions alike are alike by chance
    pub smallest: usize,
    /// Calls below which a parameter every call passes one literal for is not judged
    pub calls: usize,
}

impl Default for Settings {
    fn default() -> Settings {
        Settings {
            restated_share: restating::RESTATED_SHARE,
            filler: Vec::new(),
            vague_words: Vec::new(),
            vague_verbs: Vec::new(),
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
    smallest: Option<usize>,
    calls: Option<usize>,
}

impl Config {
    /// The config of the first folder from the current one up that holds an `orcrist.toml`, going no higher than the
    /// repository's root, or only the current folder outside a repository; the defaults when there is none.
    pub fn find() -> Result<Config, String> {
        let current = env::current_dir().map_err(|error| format!("cannot tell the current folder: {error}"))?;
        // Outside a repository no `.git` above would stop the search, and any folder above may be another's to write
        let inside_repository = git::inside_repository();
        for folder in current.ancestors() {
            let path = folder.join(FILE_NAME);
            if path.is_file() {
                let text =
                    fs::read_to_string(&path).map_err(|error| format!("cannot read {}: {error}", path.display()))?;
                return Config::parse(&text, (folder.to_path_buf(), current.clone()))
                    .map_err(|error| format!("{}: {error}", path.display()));
            }
            let last = !inside_repository || folder.join(".git").exists();
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
            let settings = &mut config.settings;
            let lowercase = |words: Vec<String>| words.into_iter().map(|word| word.to_lowercase()).collect();
            let mut set = Vec::new();
            if let Some(share) = written.share {
                if !(share > 0.0 && share <= 1.0) {
                    return Err(format!(
                        "{rule}'s share is {share}, where it is a share above 0 and at most 1"
                    ));
                }
                settings.restated_share = share;
                set.push(("share", "restating-comment"));
            }
            if let Some(filler) = written.filler {
                settings.filler = lowercase(filler);
                set.push(("filler", "restating-comment"));
            }
            if let Some(words) = written.words {
                settings.vague_words = lowercase(words);
                set.push(("words", "vague-name"));
            }
            if let Some(verbs) = written.verbs {
                settings.vague_verbs = lowercase(verbs);
                set.push(("verbs", "vague-name"));
            }
            if let Some(smallest) = written.smallest {
                if smallest == 0 {
                    return Err(format!("{rule}'s smallest is 0, where it is a count of pieces of code"));
                }
                settings.smallest = smallest;
                set.push(("smallest", "duplicate-helper"));
            }
            if let Some(calls) = written.calls {
                if calls < 2 {
                    return Err(format!(
                        "{rule}'s calls is {calls}, where every call passing one value takes two"
                    ));
                }
                settings.calls = calls;
                set.push(("calls", "single-use-abstraction"));
            }
            if let Some((key, owner)) = set.into_iter().find(|(_, owner)| *owner != rule) {
                return Err(format!("{key} is {owner}'s to set, not {rule}'s"));
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
        absolute.strip_prefix(folder).ok().map(Path::to_path_buf)
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
