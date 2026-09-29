//! Embeds `rules/**/*.toml` and `pricing/**/*.toml` so the server wasm can
//! serve the catalog and prices without a filesystem. Same files `rulec`
//! and `crates/cost` read.
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR")?);
    let repo = manifest.join("../../..");
    let out_dir = PathBuf::from(std::env::var("OUT_DIR")?);
    let mut rules = Vec::new();
    let mut prices = Vec::new();
    collect(&repo.join("rules"), &repo, &mut rules)?;
    collect(&repo.join("pricing"), &repo, &mut prices)?;
    rules.sort();
    prices.sort();
    let mut out = fs::File::create(out_dir.join("embedded.rs"))?;
    writeln!(
        out,
        "pub struct Embedded {{ pub path: &'static str, pub text: &'static str }}"
    )?;
    write_table(&mut out, "RULES", &rules)?;
    write_table(&mut out, "PRICES", &prices)?;
    println!("cargo:rerun-if-changed={}", display(&repo.join("rules")));
    println!("cargo:rerun-if-changed={}", display(&repo.join("pricing")));
    Ok(())
}

fn collect(
    dir: &Path,
    repo: &Path,
    out: &mut Vec<(String, PathBuf)>,
) -> Result<(), Box<dyn std::error::Error>> {
    if !dir.is_dir() {
        return Err(format!("missing {}", dir.display()).into());
    }
    for entry in fs::read_dir(dir)? {
        let path = entry?.path();
        if path.is_dir() {
            collect(&path, repo, out)?;
        } else if path.extension().is_some_and(|ext| ext == "toml") {
            let rel = path
                .strip_prefix(repo)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");
            println!("cargo:rerun-if-changed={}", display(&path));
            out.push((rel, path));
        }
    }
    Ok(())
}

fn write_table(
    out: &mut fs::File,
    name: &str,
    files: &[(String, PathBuf)],
) -> Result<(), Box<dyn std::error::Error>> {
    writeln!(out, "pub static {name}: &[Embedded] = &[")?;
    for (rel, path) in files {
        let literal = display(path);
        writeln!(
            out,
            "    Embedded {{ path: \"{rel}\", text: include_str!(r\"{literal}\") }},"
        )?;
    }
    writeln!(out, "];")?;
    Ok(())
}

fn display(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}
