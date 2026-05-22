use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use anyhow::{Context, Result};

pub fn ensure_workdir_layout(work_dir: &Path) -> Result<()> {
    fs::create_dir_all(work_dir).with_context(|| format!("mkdir {}", work_dir.display()))?;
    Ok(())
}

pub fn clear_directory(path: &Path) -> Result<()> {
    if !path.exists() {
        return Ok(());
    }
    for entry in fs::read_dir(path).with_context(|| format!("read_dir {}", path.display()))? {
        let entry = entry?;
        let p = entry.path();
        if p.is_dir() {
            fs::remove_dir_all(&p).with_context(|| format!("remove_dir_all {}", p.display()))?;
        } else {
            fs::remove_file(&p).with_context(|| format!("remove_file {}", p.display()))?;
        }
    }
    Ok(())
}

pub fn find_repo_root() -> Result<PathBuf> {
    let mut dir = std::env::current_dir().context("get current_dir")?;
    loop {
        let cargo_toml = dir.join("Cargo.toml");
        let capture_dir = dir.join("capture");
        if cargo_toml.is_file() && capture_dir.is_dir() {
            return Ok(dir);
        }

        if !dir.pop() {
            break;
        }
    }

    anyhow::bail!("Cannot locate repo root (need both Cargo.toml and capture/).")
}

pub fn find_all_toml_in_capture(capture_dir: &Path) -> Result<Vec<PathBuf>> {
    let mut all: Vec<PathBuf> = Vec::new();

    fn walk(dir: &Path, all: &mut Vec<PathBuf>) -> Result<()> {
        for entry in fs::read_dir(dir).with_context(|| format!("read_dir {}", dir.display()))? {
            let entry = entry?;
            let path = entry.path();
            if path.is_dir() {
                walk(&path, all)?;
                continue;
            }
            if path.extension().and_then(|e| e.to_str()) != Some("toml") {
                continue;
            }
            all.push(path);
        }
        Ok(())
    }

    walk(capture_dir, &mut all)?;
    if all.is_empty() {
        anyhow::bail!("No .toml files found under capture/.");
    }
    all.sort_by(|a, b| {
        let am = fs::metadata(a).and_then(|m| m.modified()).unwrap_or(SystemTime::UNIX_EPOCH);
        let bm = fs::metadata(b).and_then(|m| m.modified()).unwrap_or(SystemTime::UNIX_EPOCH);
        am.cmp(&bm)
    });
    Ok(all)
}

pub fn group_tomls_by_first_subdir(
    capture_dir: &Path,
    tomls: &[PathBuf],
) -> Result<Vec<(String, Vec<PathBuf>)>> {
    use std::collections::BTreeMap;
    let mut groups: BTreeMap<String, Vec<PathBuf>> = BTreeMap::new();
    for p in tomls {
        let rel = p
            .strip_prefix(capture_dir)
            .with_context(|| format!("{} is not under {}", p.display(), capture_dir.display()))?;
        let mut comps = rel.components();
        let Some(first) = comps.next() else { continue };
        let name = first.as_os_str().to_string_lossy().to_string();
        groups.entry(name).or_default().push(p.clone());
    }
    Ok(groups.into_iter().collect())
}

pub fn encode_coord(v: i32) -> String {
    v.to_string()
}
