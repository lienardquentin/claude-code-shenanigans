//! What the rules that look across files found in each file of the project, kept between runs, so that a run reads
//! again only the files that changed. Each file's findings are kept under a key made of its content, its language,
//! the settings that shape them and the orcrist binary that found them, in `orcrist-cache` in the repository's git
//! folder; a run outside a repository keeps nothing. Losing them costs time and nothing else: a file whose findings
//! cannot be read is parsed again, and a run that cannot write them leaves them unwritten. A key is a 64-bit hash: two
//! contents share one by chance one in 2^64, though a file written to collide with another could take its findings,
//! which costs a wrong finding and nothing more.

use std::collections::hash_map::DefaultHasher;
use std::env;
use std::fs;
use std::hash::{Hash, Hasher};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use crate::config::Settings;
use crate::git::{self, git};
use crate::lang::Language;
use crate::rules::Found;

/// How long a file's findings no run used are kept.
const KEPT_FOR: Duration = Duration::from_secs(7 * 24 * 60 * 60);

pub struct Cache {
    /// The folder the findings are kept in, None where there is no repository to keep them in
    folder: Option<PathBuf>,
    /// What keys every file's findings besides the file itself: this binary, and the settings that shape them
    salt: u64,
}

impl Cache {
    pub fn open(settings: &Settings) -> Cache {
        let mut salt = DefaultHasher::new();
        // A binary rebuilt from changed rules is another file, or the same one written later
        let binary = env::current_exe().ok().and_then(|path| {
            let metadata = fs::metadata(&path).ok()?;
            Some((path, metadata.len(), metadata.modified().ok()))
        });
        binary.hash(&mut salt);
        settings.smallest.hash(&mut salt);
        Cache {
            folder: binary.and_then(|_| folder()),
            salt: salt.finish(),
        }
    }

    /// The findings of a file of `language` whose content is `source`: the kept ones, or `find`'s, then kept.
    pub fn found(&self, language: Language, source: &str, find: impl FnOnce() -> Found) -> Found {
        let Some(folder) = &self.folder else {
            return find();
        };
        let mut key = DefaultHasher::new();
        (self.salt, language, source).hash(&mut key);
        let path = folder.join(format!("{:016x}.json", key.finish()));
        if let Some(found) = read(&path) {
            return found;
        }
        let found = find();
        write(&path, &found);
        found
    }

    /// Lets go of the findings no run has used for a week.
    pub fn prune(&self) {
        let Some(entries) = self.folder.as_ref().and_then(|folder| fs::read_dir(folder).ok()) else {
            return;
        };
        let now = SystemTime::now();
        for entry in entries.flatten() {
            // Only what orcrist wrote, as plain files: a folder handed over with its own `.git` may hold others
            let plain = entry.file_type().is_ok_and(|kind| kind.is_file());
            if !plain || !entry.file_name().to_str().is_some_and(ours) {
                continue;
            }
            let unused_for = entry
                .metadata()
                .and_then(|metadata| metadata.modified())
                .ok()
                .and_then(|modified| now.duration_since(modified).ok());
            if unused_for.is_some_and(|unused_for| unused_for > KEPT_FOR) {
                // Another run may have let it go first, which is all this asks
                fs::remove_file(entry.path()).ok(); // orcrist: spare swallowed-error: a cache entry left is only kept longer
            }
        }
    }
}

/// `orcrist-cache` in the git folder the repository's worktrees share, made when missing.
fn folder() -> Option<PathBuf> {
    if !git::inside_repository() {
        return None;
    }
    let common = git(&["rev-parse", "--path-format=absolute", "--git-common-dir"]).ok()?;
    let folder = Path::new(common.trim()).join("orcrist-cache");
    match fs::symlink_metadata(&folder) {
        Ok(metadata) if metadata.is_dir() && private(&metadata) && owned(&folder, &metadata) => Some(folder),
        // A link or a file where the folder should be is no cache orcrist made: it keeps nothing rather than follow it
        Ok(_) => None,
        Err(_) => make_private_folder(&folder).ok().map(|()| folder),
    }
}

/// Whether no one but its owner may read or write in the folder; on a system without such modes, whether it is one.
fn private(metadata: &fs::Metadata) -> bool {
    #[cfg(unix)]
    return std::os::unix::fs::PermissionsExt::mode(&metadata.permissions()) & 0o077 == 0;
    #[cfg(not(unix))]
    return metadata.is_dir();
}

/// Whether this run owns the folder: a file it makes there is its own, and has the folder's owner. A run as one user
/// trusts nothing another user could have written, root's run in another's repository among them.
fn owned(folder: &Path, metadata: &fs::Metadata) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        // Named as a half-written entry, so that one left by a run cut short is let go with them
        let probe = folder.join(format!("{:016x}.{}.writing", 0, std::process::id()));
        let made = fs::File::options().write(true).create_new(true).open(&probe);
        let same = made
            .and_then(|file| file.metadata())
            .is_ok_and(|made| made.uid() == metadata.uid());
        fs::remove_file(&probe).ok(); // orcrist: spare swallowed-error: a probe left behind is pruned as a half entry
        same
    }
    #[cfg(not(unix))]
    {
        let _ = (folder, metadata);
        true
    }
}

/// A folder its owner alone can read: the literals a file's calls pass, which may be secrets, are kept in it.
fn make_private_folder(folder: &Path) -> std::io::Result<()> {
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
    builder.create(folder)
}

/// Whether `name` is one orcrist gives what it keeps: `<16 hex>.json`, or `<16 hex>.<process>.writing` half written.
fn ours(name: &str) -> bool {
    let key = |part: &str| part.len() == 16 && part.bytes().all(|byte| byte.is_ascii_hexdigit());
    let number = |part: &str| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit());
    match name.split('.').collect::<Vec<_>>()[..] {
        [hex, "json"] => key(hex),
        [hex, process, "writing"] => key(hex) && number(process),
        _ => false,
    }
}

/// The findings kept at `path`, marked as used, or None when there are none it can read.
fn read(path: &Path) -> Option<Found> {
    if !fs::symlink_metadata(path).is_ok_and(|metadata| metadata.is_file()) {
        return None;
    }
    let text = fs::read_to_string(path).ok()?;
    let found = serde_json::from_str(&text).ok()?;
    if let Ok(file) = fs::File::options().write(true).open(path) {
        // Marked used so that pruning keeps it; one left unmarked is only let go sooner
        file.set_modified(SystemTime::now()).ok(); // orcrist: spare swallowed-error: an entry pruned early is found again
    }
    Some(found)
}

/// Keeps `found` at `path`, written beside it and renamed into place so that a run reading it never sees it half
/// written. The file it writes first is a new one, never one already there, a link among them; the rename replaces
/// what is at `path` rather than follow it.
fn write(path: &Path, found: &Found) {
    let Ok(text) = serde_json::to_string(found) else {
        return;
    };
    let writing = path.with_extension(format!("{}.writing", std::process::id()));
    let mut options = fs::File::options();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let Ok(mut file) = options.open(&writing) else {
        return;
    };
    if file.write_all(text.as_bytes()).is_err() || fs::rename(&writing, path).is_err() {
        fs::remove_file(&writing).ok(); // orcrist: spare swallowed-error: a stray half entry is pruned with the rest
    }
}
