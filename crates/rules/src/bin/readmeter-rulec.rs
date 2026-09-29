//! Rule compiler: `rules/**/*.toml` -> JSON artifacts.
//!
//! ```text
//! readmeter-rulec check  <rules-dir>
//! readmeter-rulec build  <rules-dir> <out-dir> [--revision <rev>]
//! ```
//!
//! `build` writes:
//! - `catalog.json`: full definitions (console, docs site, backend evaluator)
//! - `bundle.json`:  engine specs only, default config (evaluator / rule CDN JSON)
//! - `bundle.bin`:   same revision, binary format SDKs load
//!
//! The revision defaults to a content hash of the catalog so identical
//! inputs always produce identical artifacts.

use std::hash::{DefaultHasher, Hash, Hasher};
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use readmeter_rules::{Catalog, RuleConfig, Status};

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match run(&args) {
        Ok(()) => ExitCode::SUCCESS,
        Err(msg) => {
            eprintln!("readmeter-rulec: {msg}");
            ExitCode::FAILURE
        }
    }
}

fn run(args: &[String]) -> Result<(), String> {
    match args {
        [cmd, dir] if cmd == "check" => {
            let catalog = load(Path::new(dir))?;
            print_summary(&catalog);
            Ok(())
        }
        [cmd, dir, out, rest @ ..] if cmd == "build" => {
            let revision = match rest {
                [] => None,
                [flag, rev] if flag == "--revision" => Some(rev.clone()),
                _ => return Err(usage()),
            };
            build(Path::new(dir), &PathBuf::from(out), revision)
        }
        _ => Err(usage()),
    }
}

fn usage() -> String {
    "usage: readmeter-rulec check <rules-dir> | build <rules-dir> <out-dir> [--revision <rev>]"
        .into()
}

fn load(dir: &Path) -> Result<Catalog, String> {
    Catalog::load_dir(dir).map_err(|e| e.to_string())
}

fn build(dir: &Path, out: &Path, revision: Option<String>) -> Result<(), String> {
    let catalog = load(dir)?;
    let catalog_json = serde_json::to_string_pretty(&catalog).map_err(|e| e.to_string())?;
    let revision = revision.unwrap_or_else(|| content_revision(&catalog_json));
    let bundle = catalog.bundle(&revision, RuleConfig::default());
    let bundle_json = serde_json::to_string(&bundle).map_err(|e| e.to_string())?;
    let bundle_bin = bundle.encode().map_err(|e| e.to_string())?;

    std::fs::create_dir_all(out).map_err(|e| format!("{}: {e}", out.display()))?;
    write(&out.join("catalog.json"), &catalog_json)?;
    write(&out.join("bundle.json"), &bundle_json)?;
    write_bytes(&out.join("bundle.bin"), &bundle_bin)?;
    print_summary(&catalog);
    println!(
        "revision {revision}: catalog.json {} B, bundle.json {} B, bundle.bin {} B",
        catalog_json.len(),
        bundle_json.len(),
        bundle_bin.len()
    );
    Ok(())
}

fn write(path: &Path, text: &str) -> Result<(), String> {
    std::fs::write(path, text).map_err(|e| format!("{}: {e}", path.display()))
}

fn write_bytes(path: &Path, bytes: &[u8]) -> Result<(), String> {
    std::fs::write(path, bytes).map_err(|e| format!("{}: {e}", path.display()))
}

/// Stable within one toolchain; good enough for cache busting. The CDN
/// signs bundles separately.
fn content_revision(text: &str) -> String {
    let mut h = DefaultHasher::new();
    text.hash(&mut h);
    format!("{:016x}", h.finish())
}

fn print_summary(catalog: &Catalog) {
    let count = |s: Status| catalog.rules.iter().filter(|r| r.status == s).count();
    println!(
        "{} rules: {} stable, {} beta, {} planned",
        catalog.rules.len(),
        count(Status::Stable),
        count(Status::Beta),
        count(Status::Planned)
    );
}
