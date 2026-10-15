mod chronicle;
mod config;
mod sync;
mod table;
mod time;

use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{self, BufRead, Read, Write};
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use clap::{CommandFactory, Parser, Subcommand, ValueEnum, ValueHint};
use clap_complete::Shell;
use serde::Serialize;

use chronicle::{BEACONS, Lighting, NO_KEEPER};

/// Reads and keeps a chronicle of beacon lightings.
#[derive(Parser)]
#[command(name = "narsil", version)]
struct Cli {
    /// The chronicle to work on: this, else the one the config names, else chronicle.jsonl
    #[arg(long, global = true, env = "NARSIL_CHRONICLE", value_name = "FILE")]
    chronicle: Option<PathBuf>,

    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// List the lightings
    Ls {
        #[arg(long, value_enum, default_value_t = Format::Table)]
        format: Format,
        /// Only the lightings from this date on, as 3019-03-08 or 3019-03-08T06:00:00Z
        #[arg(long, value_name = "DATE")]
        since: Option<String>,
    },
    /// Show one lighting
    Show {
        /// The lighting's id
        id: u64,
        #[arg(long, value_enum, default_value_t = Format::Table)]
        format: Format,
    },
    /// Count the lightings and their watchers
    Tally {
        #[arg(long, value_enum, default_value_t = By::Beacon)]
        by: By,
        #[arg(long, value_enum, default_value_t = Format::Table)]
        format: Format,
    },
    /// Copy a file, showing how far it got
    Copy {
        src: PathBuf,
        dst: PathBuf,
        /// Write over DST when it is there
        #[arg(long)]
        force: bool,
    },
    /// Write a file's checksum beside it, as FILE.seal
    Seal {
        file: PathBuf,
        /// Compare the file with its seal and write nothing
        #[arg(long)]
        check: bool,
    },
    /// Ask for a lighting and write it at the end of the chronicle
    Scribe,
    /// Tend the chronicle itself
    Archive {
        #[command(subcommand)]
        command: Archive,
    },
    /// Write a chronicle of made-up lightings, the same ones for the same seed
    Forge {
        dst: PathBuf,
        #[arg(long, default_value_t = 1000)]
        count: u64,
        #[arg(long, default_value_t = 3019)]
        seed: u64,
        /// Write over DST when it is there
        #[arg(long)]
        force: bool,
    },
    /// Append what Gondor lit and the chronicle has not, under fresh ids
    Sync {
        /// Where Gondor answers, as http://127.0.0.1:8101
        #[arg(long, value_name = "URL", value_hint = ValueHint::Url)]
        from: String,
        /// Say what would be appended and write nothing
        #[arg(long)]
        dry_run: bool,
    },
    /// Print the completions of a shell
    Completions { shell: Shell },
}

#[derive(Subcommand)]
enum Archive {
    /// Take the lightings before a date out of the chronicle
    Prune {
        /// As 3019-03-08 or 3019-03-08T06:00:00Z
        #[arg(long, value_name = "DATE")]
        before: String,
        /// Say what would go and write nothing
        #[arg(long)]
        dry_run: bool,
    },
}

#[derive(Clone, Copy, ValueEnum)]
enum Format {
    Table,
    Json,
}

#[derive(Clone, Copy, ValueEnum)]
enum By {
    Beacon,
    Keeper,
    Realm,
}

#[derive(Serialize)]
struct Count {
    name: Option<String>,
    lightings: u64,
    watchers: u64,
}

fn said(path: &Path, error: impl std::fmt::Display) -> String {
    format!("{}: {error}", path.display())
}

fn json<T: Serialize + ?Sized>(value: &T) {
    println!(
        "{}",
        serde_json::to_string_pretty(value).expect("what narsil prints is always JSON")
    );
}

fn refuse_to_overwrite(dst: &Path, force: bool) -> Result<(), String> {
    if dst.exists() && !force {
        return Err(format!("{} is already there; --force writes over it", dst.display()));
    }
    Ok(())
}

fn ls(lightings: Vec<Lighting>, format: Format, since: Option<String>) {
    let lightings: Vec<Lighting> = match since {
        Some(since) => lightings.into_iter().filter(|l| l.lit_at >= since).collect(),
        None => lightings,
    };
    match format {
        Format::Table => table::print(&lightings),
        Format::Json => json(&lightings),
    }
}

fn show(lightings: &[Lighting], id: u64, format: Format) -> Result<(), String> {
    let first = &lightings[0];
    let (index, lighting) = lightings
        .iter()
        .enumerate()
        .find(|(_, lighting)| lighting.id == id)
        .ok_or_else(|| format!("lighting {id} is not in the chronicle"))?;
    match format {
        Format::Json => json(lighting),
        Format::Table => {
            println!("Lighting {}", lighting.id);
            println!("  Beacon    {}", lighting.beacon);
            println!("  Realm     {}", lighting.realm);
            println!("  Lit at    {}", lighting.lit_at);
            println!("  Keeper    {}", lighting.keeper.as_deref().unwrap_or(NO_KEEPER));
            println!("  Watchers  {}", lighting.watchers);
            if !lighting.note.is_empty() {
                println!("  Note      {}", lighting.note);
            }
            println!(
                "The {} of {} in the chronicle, which opens on {} at {}",
                ordinal(index + 1),
                lightings.len(),
                first.beacon,
                first.lit_at
            );
        }
    }
    Ok(())
}

fn ordinal(n: usize) -> String {
    let suffix = match (n % 10, n % 100) {
        (1, 11) | (2, 12) | (3, 13) => "th",
        (1, _) => "st",
        (2, _) => "nd",
        (3, _) => "rd",
        _ => "th",
    };
    format!("{n}{suffix}")
}

fn tally(lightings: &[Lighting], by: By, format: Format) {
    let mut counts: HashMap<Option<&str>, (u64, u64)> = HashMap::new();
    for lighting in lightings {
        let name = match by {
            By::Beacon => Some(lighting.beacon.as_str()),
            By::Keeper => lighting.keeper.as_deref(),
            By::Realm => Some(lighting.realm.as_str()),
        };
        let count = counts.entry(name).or_default();
        count.0 += 1;
        count.1 += u64::from(lighting.watchers);
    }
    let mut counts: Vec<Count> = counts
        .into_iter()
        .map(|(name, (lightings, watchers))| Count {
            name: name.map(str::to_string),
            lightings,
            watchers,
        })
        .collect();
    counts.sort_by(|a, b| b.lightings.cmp(&a.lightings).then_with(|| a.name.cmp(&b.name)));
    match format {
        Format::Json => json(&counts),
        Format::Table => {
            let name = counts.iter().map(|c| c.name.as_deref().unwrap_or(NO_KEEPER).chars().count()).max().unwrap_or(0).max(4);
            println!("{:<name$}  {:>9}  {:>8}", "NAME", "LIGHTINGS", "WATCHERS");
            for count in &counts {
                println!("{:<name$}  {:>9}  {:>8}", count.name.as_deref().unwrap_or(NO_KEEPER), count.lightings, count.watchers);
            }
            let lightings: u64 = counts.iter().map(|count| count.lightings).sum();
            let watchers: u64 = counts.iter().map(|count| count.watchers).sum();
            println!("{:<name$}  {:>9}  {:>8}", "ALL", lightings, watchers);
        }
    }
}

fn copy(src: &Path, dst: &Path, force: bool) -> Result<(), String> {
    refuse_to_overwrite(dst, force)?;
    let mut from = File::open(src).map_err(|error| said(src, error))?;
    let total = from.metadata().map_err(|error| said(src, error))?.len();
    let mut to = File::create(dst).map_err(|error| said(dst, error))?;
    let mut buffer = vec![0; 64 * 1024];
    let mut done: u64 = 0;
    loop {
        let read = from.read(&mut buffer).map_err(|error| said(src, error))?;
        if read == 0 {
            break;
        }
        to.write_all(&buffer[..read]).map_err(|error| said(dst, error))?;
        done += read as u64;
        let filled = (done * 30 / total.max(1)) as usize;
        print!(
            "\r[{}{}] {:>3}%",
            "#".repeat(filled),
            " ".repeat(30 - filled),
            done * 100 / total.max(1)
        );
        io::stdout().flush().ok();
    }
    if done > 0 {
        println!();
    }
    println!("copied {done} bytes to {}", dst.display());
    Ok(())
}

/// FNV-1a over 64 bits: enough to tell that a file changed, and no proof of who changed it.
fn checksum(path: &Path) -> Result<String, String> {
    let bytes = fs::read(path).map_err(|error| said(path, error))?;
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in bytes {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    Ok(format!("{hash:016x}"))
}

fn seal(file: &Path, check: bool) -> Result<(), String> {
    let mut beside = file.as_os_str().to_owned();
    beside.push(".seal");
    let beside = Path::new(&beside);
    let sum = checksum(file)?;
    if !check {
        fs::write(beside, format!("fnv1a64 {sum}\n")).map_err(|error| said(beside, error))?;
        println!("sealed {} as {sum}", file.display());
        return Ok(());
    }
    let kept = fs::read_to_string(beside).map_err(|error| said(beside, error))?;
    if kept.trim() == format!("fnv1a64 {sum}") {
        println!("{} is as it was sealed", file.display());
        Ok(())
    } else {
        Err(format!("{} is not as it was sealed", file.display()))
    }
}

/// Asks on stderr and reads a line of stdin, so what is piped to narsil answers as well as what is typed.
fn ask(label: &str) -> Result<String, String> {
    eprint!("{label}: ");
    io::stderr().flush().ok();
    let mut answer = String::new();
    let read = io::stdin()
        .lock()
        .read_line(&mut answer)
        .map_err(|error| format!("stdin: {error}"))?;
    if read == 0 {
        eprintln!();
        return Err("the scribe was stopped before the lighting was written".to_string());
    }
    Ok(answer.trim().to_string())
}

fn scribe(path: &Path, lightings: &[Lighting], keeper: Option<String>) -> Result<(), String> {
    let beacon = loop {
        let answer = ask("Beacon")?;
        match BEACONS.iter().find(|beacon| beacon.eq_ignore_ascii_case(&answer)) {
            Some(beacon) => break beacon.to_string(),
            None => eprintln!("Not a beacon of Gondor. One of: {}", BEACONS.join(", ")),
        }
    };
    let realm = loop {
        let answer = ask("Realm that called for it")?;
        if !answer.is_empty() {
            break answer;
        }
    };
    let keeper = loop {
        let answer = match &keeper {
            Some(keeper) => ask(&format!("Keeper [{keeper}]"))?,
            None => ask("Keeper")?,
        };
        match (answer.is_empty(), &keeper) {
            (false, _) => break answer,
            (true, Some(keeper)) => break keeper.clone(),
            (true, None) => {}
        }
    };
    let watchers = loop {
        match ask("Watchers on the hill")?.parse() {
            Ok(watchers) => break watchers,
            Err(_) => eprintln!("A number of men, as 12."),
        }
    };
    let note = ask("Note, or nothing")?;
    let lighting = Lighting {
        id: lightings.iter().map(|lighting| lighting.id).max().unwrap_or(0) + 1,
        beacon,
        realm,
        lit_at: time::now(),
        keeper: Some(keeper),
        watchers,
        note,
    };
    chronicle::append(path, &lighting)?;
    println!("wrote lighting {} to {}", lighting.id, path.display());
    Ok(())
}

fn prune(path: &Path, lightings: Vec<Lighting>, before: &str, dry_run: bool) -> Result<(), String> {
    let (gone, kept): (Vec<Lighting>, Vec<Lighting>) = lightings
        .into_iter()
        .partition(|lighting| lighting.lit_at.as_str() < before);
    if dry_run {
        println!("would take {} lightings out, and leave {}", gone.len(), kept.len());
        return Ok(());
    }
    chronicle::write(path, &kept)?;
    println!("took {} lightings out, {} are left", gone.len(), kept.len());
    Ok(())
}

fn run(cli: Cli) -> Result<(), String> {
    let config = config::read();
    let path = cli
        .chronicle
        .or(config.chronicle)
        .unwrap_or_else(|| PathBuf::from("chronicle.jsonl"));
    match cli.command {
        Command::Ls { format, since } => ls(chronicle::read(&path)?, format, since),
        Command::Show { id, format } => show(&chronicle::read(&path)?, id, format)?,
        Command::Tally { by, format } => tally(&chronicle::read(&path)?, by, format),
        Command::Copy { src, dst, force } => copy(&src, &dst, force)?,
        Command::Seal { file, check } => seal(&file, check)?,
        Command::Scribe => {
            // A chronicle that is not there yet is one the scribe starts.
            let lightings = if path.exists() {
                chronicle::read(&path)?
            } else {
                Vec::new()
            };
            scribe(&path, &lightings, config.keeper)?;
        }
        Command::Archive {
            command: Archive::Prune { before, dry_run },
        } => {
            prune(&path, chronicle::read(&path)?, &before, dry_run)?;
        }
        Command::Forge {
            dst,
            count,
            seed,
            force,
        } => {
            refuse_to_overwrite(&dst, force)?;
            chronicle::write(&dst, &chronicle::forge(count, seed))?;
            println!("forged {count} lightings in {}", dst.display());
        }
        Command::Sync { from, dry_run } => sync::sync(&path, &from, dry_run)?,
        Command::Completions { shell } => {
            clap_complete::generate(shell, &mut Cli::command(), "narsil", &mut io::stdout());
        }
    }
    Ok(())
}

fn main() -> ExitCode {
    match run(Cli::parse()) {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("narsil: {message}");
            ExitCode::from(1)
        }
    }
}
