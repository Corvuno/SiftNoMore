//! Walking the folders the user chose and reading what each file is, without opening it.

use crate::model::{FileEntry, Kind, Stats};
use crate::names::split_ext;
use globset::{Glob, GlobSet, GlobSetBuilder};
use std::collections::HashSet;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use walkdir::WalkDir;

/// Turns the user's skip patterns into one matcher. A pattern matches a path or anything under
/// it, so a plain folder path skips that folder. Matching ignores case and treats \ and / alike.
pub fn skip_matcher(patterns: &[String]) -> GlobSet {
    let mut b = GlobSetBuilder::new();
    for p in patterns {
        let p = p.trim();
        if p.is_empty() {
            continue;
        }
        let norm = p.replace('\\', "/").to_lowercase();
        let norm = norm.trim_end_matches('/').to_string();
        for g in [norm.clone(), format!("{norm}/**")] {
            if let Ok(glob) = Glob::new(&g) {
                b.add(glob);
            }
        }
    }
    b.build().unwrap_or_else(|_| GlobSet::empty())
}

pub fn norm_path(p: &str) -> String {
    p.replace('\\', "/").to_lowercase()
}

fn secs(t: std::io::Result<SystemTime>) -> i64 {
    t.ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

pub struct Walked {
    pub files: Vec<FileEntry>,
    /// Every folder seen, as normalised paths, so "is this archive unpacked?" can be answered.
    pub dirs: HashSet<String>,
    pub stats: Stats,
}

/// Walks every folder, skipping what the patterns say. Calls `progress` now and then with the
/// number of files seen. Stops early (and says so) when `cancel` is set.
pub fn walk(
    folders: &[String],
    skip: &GlobSet,
    cancel: &AtomicBool,
    mut progress: impl FnMut(u64),
) -> Walked {
    let mut out = Walked {
        files: Vec::new(),
        dirs: HashSet::new(),
        stats: Stats::default(),
    };
    let mut seen_paths: HashSet<String> = HashSet::new();
    for root in folders {
        let walker = WalkDir::new(root)
            .follow_links(false)
            .into_iter()
            .filter_entry(|e| {
                let p = norm_path(&e.path().to_string_lossy());
                !skip.is_match(&p)
            });
        for entry in walker {
            if cancel.load(Ordering::Relaxed) {
                return out;
            }
            let entry = match entry {
                Ok(e) => e,
                Err(_) => {
                    out.stats.unreadable += 1;
                    continue;
                }
            };
            let path_str = entry.path().to_string_lossy().to_string();
            if entry.file_type().is_dir() {
                out.stats.folders_seen += 1;
                out.dirs.insert(norm_path(&path_str));
                continue;
            }
            if !entry.file_type().is_file() {
                continue;
            }
            // Folders the user chose can overlap ("Downloads" and "Downloads\Old").
            if !seen_paths.insert(norm_path(&path_str)) {
                continue;
            }
            let meta = match entry.metadata() {
                Ok(m) => m,
                Err(_) => {
                    out.stats.unreadable += 1;
                    continue;
                }
            };
            let name = entry.file_name().to_string_lossy().to_string();
            let (_, ext) = split_ext(&name);
            let modified = secs(meta.modified());
            let touched = modified
                .max(secs(meta.accessed()))
                .max(secs(meta.created()));
            let dir = entry
                .path()
                .parent()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default();
            out.stats.files_seen += 1;
            out.stats.bytes_seen += meta.len();
            out.files.push(FileEntry {
                id: out.files.len() as u32,
                path: path_str,
                dir,
                kind: Kind::of_ext(&ext),
                name,
                ext,
                size: meta.len(),
                modified,
                touched,
                origin: None,
                origin_detail: None,
                kept: false,
            });
            if out.stats.files_seen.is_multiple_of(2000) {
                progress(out.stats.files_seen);
            }
        }
    }
    progress(out.stats.files_seen);
    out
}

/// Reads the website a downloaded file came from. Windows keeps this in a small hidden part of
/// the file ("Zone.Identifier"). Returns the host, like "github.com", or None.
pub fn read_origin(path: &str) -> Option<(String, String)> {
    let mark = format!("{path}:Zone.Identifier");
    let bytes = std::fs::read(Path::new(&mark)).ok()?;
    parse_zone_identifier(&String::from_utf8_lossy(&bytes))
}

/// Gives (host to show, the full addresses Windows recorded).
pub fn parse_zone_identifier(text: &str) -> Option<(String, String)> {
    let mut host_url = None;
    let mut referrer = None;
    for line in text.lines() {
        let line = line.trim().trim_start_matches('\u{feff}');
        if let Some(v) = line.strip_prefix("HostUrl=") {
            host_url = Some(v.to_string());
        } else if let Some(v) = line.strip_prefix("ReferrerUrl=") {
            referrer = Some(v.to_string());
        }
    }
    // The referrer is the page you were on; the host URL is often a download server
    // ("objects.githubusercontent.com"), so the page says more about where it came from.
    let mut detail = Vec::new();
    if let Some(r) = &referrer {
        detail.push(format!("Page: {r}"));
    }
    if let Some(h) = &host_url {
        detail.push(format!("File: {h}"));
    }
    let host = referrer
        .as_deref()
        .and_then(host_of)
        .or_else(|| host_url.as_deref().and_then(host_of))?;
    Some((host, detail.join("\n")))
}

fn host_of(url: &str) -> Option<String> {
    let rest = url.split("://").nth(1)?;
    let host = rest.split(['/', '?', '#']).next()?;
    let host = host.rsplit('@').next()?.split(':').next()?.to_lowercase();
    if host.is_empty() || host == "about" {
        return None;
    }
    Some(host.strip_prefix("www.").unwrap_or(&host).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zone_identifier() {
        let t = "[ZoneTransfer]\r\nZoneId=3\r\nReferrerUrl=https://www.videolan.org/vlc/\r\nHostUrl=https://get.videolan.org/vlc/3.0.20/win64/vlc.exe\r\n";
        let (host, detail) = parse_zone_identifier(t).unwrap();
        assert_eq!(host, "videolan.org");
        assert!(detail.contains("Page: https://www.videolan.org/vlc/"));
        assert!(detail.contains("File: https://get.videolan.org/"));
        let t = "[ZoneTransfer]\nZoneId=3\nHostUrl=https://objects.githubusercontent.com/x\n";
        assert_eq!(
            parse_zone_identifier(t).unwrap().0,
            "objects.githubusercontent.com"
        );
        assert_eq!(parse_zone_identifier("[ZoneTransfer]\nZoneId=3\n"), None);
        assert_eq!(parse_zone_identifier("HostUrl=about:internet"), None);
    }

    #[test]
    fn walks_and_skips() {
        let d = tempfile::tempdir().unwrap();
        let root = d.path();
        std::fs::create_dir_all(root.join("keep/sub")).unwrap();
        std::fs::create_dir_all(root.join("node_modules/x")).unwrap();
        std::fs::write(root.join("a.zip"), b"zip").unwrap();
        std::fs::write(root.join("keep/sub/b.pdf"), b"pdf").unwrap();
        std::fs::write(root.join("node_modules/x/c.js"), b"js").unwrap();
        let skip = skip_matcher(&["*/node_modules".to_string()]);
        let cancel = AtomicBool::new(false);
        let root_s = root.to_string_lossy().to_string();
        // The same folder twice must not count files twice.
        let w = walk(&[root_s.clone(), root_s], &skip, &cancel, |_| {});
        let mut names: Vec<_> = w.files.iter().map(|f| f.name.clone()).collect();
        names.sort();
        assert_eq!(names, vec!["a.zip", "b.pdf"]);
        assert!(w.dirs.iter().any(|d| d.ends_with("keep/sub")));
        assert_eq!(
            w.files.iter().find(|f| f.name == "a.zip").unwrap().kind,
            Kind::Archive
        );
    }

    #[test]
    fn skip_patterns() {
        let s = skip_matcher(&["C:\\Users\\Kuno\\Downloads\\Games".into(), "*.tmp".into()]);
        assert!(s.is_match(norm_path("C:\\Users\\Kuno\\Downloads\\Games\\x\\y.exe")));
        assert!(s.is_match(norm_path("C:\\Users\\Kuno\\Downloads\\games")));
        assert!(s.is_match(norm_path("C:\\a\\b.TMP")));
        assert!(!s.is_match(norm_path("C:\\Users\\Kuno\\Downloads\\Gamesx\\a")));
    }
}
