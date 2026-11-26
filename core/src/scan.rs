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

pub(crate) fn secs(t: std::io::Result<SystemTime>) -> i64 {
    t.ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// A folder to look in, and whether to go into its subfolders.
#[derive(Debug, Clone)]
pub struct ScanFolder {
    pub path: String,
    pub recursive: bool,
}

/// Which date "only files dated from/to" looks at.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DateBy {
    #[default]
    Modified,
    Created,
}

/// What a file must be to be looked at at all.
#[derive(Debug, Clone, Default)]
pub struct Filters {
    /// Larger files are left out. 0 means no limit.
    pub max_size: u64,
    /// Only these extensions (lower case, no dot). Empty means all.
    pub extensions: Vec<String>,
    pub date_by: DateBy,
    pub date_from: Option<i64>,
    pub date_to: Option<i64>,
    /// Leave out the folders Windows itself lives in (at a drive root).
    pub skip_system: bool,
}

/// Folders at a drive root that belong to Windows and its programs.
const SYSTEM_DIRS: &[&str] = &[
    "windows",
    "program files",
    "program files (x86)",
    "programdata",
    "$recycle.bin",
    "system volume information",
];

/// Is this (normalised) path inside one of the Windows system folders at a drive root?
pub fn is_system_path(norm: &str) -> bool {
    let b = norm.as_bytes();
    if b.len() < 4 || b[1] != b':' || b[2] != b'/' {
        return false;
    }
    let first = norm[3..].split('/').next().unwrap_or("");
    SYSTEM_DIRS.contains(&first)
}

impl Filters {
    fn allows(&self, f: &FileEntry) -> bool {
        if self.max_size > 0 && f.size > self.max_size {
            return false;
        }
        if !self.extensions.is_empty() {
            let ext = f.ext.to_lowercase();
            let name = f.name.to_lowercase();
            let hit = self.extensions.iter().any(|e| {
                let e = e
                    .trim()
                    .trim_start_matches("*.")
                    .trim_start_matches('.')
                    .to_lowercase();
                !e.is_empty() && (ext == e || name.ends_with(&format!(".{e}")))
            });
            if !hit {
                return false;
            }
        }
        if self.date_from.is_some() || self.date_to.is_some() {
            let d = match self.date_by {
                DateBy::Created if f.created > 0 => f.created,
                _ => f.modified,
            };
            if self.date_from.is_some_and(|from| d < from) || self.date_to.is_some_and(|to| d > to)
            {
                return false;
            }
        }
        true
    }
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
    folders: &[ScanFolder],
    skip: &GlobSet,
    filters: &Filters,
    cancel: &AtomicBool,
    mut progress: impl FnMut(u64),
) -> Walked {
    let mut out = Walked {
        files: Vec::new(),
        dirs: HashSet::new(),
        stats: Stats::default(),
    };
    let mut seen_paths: HashSet<String> = HashSet::new();
    for folder in folders {
        let mut walker = WalkDir::new(&folder.path).follow_links(false);
        if !folder.recursive {
            walker = walker.max_depth(1);
        }
        let walker = walker.into_iter().filter_entry(|e| {
            let p = norm_path(&e.path().to_string_lossy());
            !skip.is_match(&p) && !(filters.skip_system && is_system_path(&p))
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
            let entry = FileEntry {
                id: out.files.len() as u32,
                path: path_str,
                dir,
                kind: Kind::of_ext(&ext),
                name,
                ext,
                size: meta.len(),
                modified,
                created: secs(meta.created()),
                touched,
                origin: None,
                origin_detail: None,
                kept: false,
            };
            if !filters.allows(&entry) {
                continue;
            }
            out.stats.files_seen += 1;
            out.stats.bytes_seen += meta.len();
            out.files.push(entry);
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
        let both = |p: &String| ScanFolder {
            path: p.clone(),
            recursive: true,
        };
        let w = walk(
            &[both(&root_s), both(&root_s)],
            &skip,
            &Filters::default(),
            &cancel,
            |_| {},
        );
        let mut names: Vec<_> = w.files.iter().map(|f| f.name.clone()).collect();
        names.sort();
        assert_eq!(names, vec!["a.zip", "b.pdf"]);
        assert!(w.dirs.iter().any(|d| d.ends_with("keep/sub")));
        assert_eq!(
            w.files.iter().find(|f| f.name == "a.zip").unwrap().kind,
            Kind::Archive
        );
    }

    fn walk_names(root: &Path, folders: &[(&str, bool)], filters: &Filters) -> Vec<String> {
        let f: Vec<ScanFolder> = folders
            .iter()
            .map(|(p, r)| ScanFolder {
                path: root.join(p).to_string_lossy().to_string(),
                recursive: *r,
            })
            .collect();
        let cancel = AtomicBool::new(false);
        let mut n: Vec<_> = walk(&f, &skip_matcher(&[]), filters, &cancel, |_| {})
            .files
            .iter()
            .map(|f| f.name.clone())
            .collect();
        n.sort();
        n
    }

    #[test]
    fn per_folder_recursion() {
        let d = tempfile::tempdir().unwrap();
        let r = d.path();
        std::fs::create_dir_all(r.join("a/deep")).unwrap();
        std::fs::create_dir_all(r.join("b/deep")).unwrap();
        std::fs::write(r.join("a/top.txt"), b"1").unwrap();
        std::fs::write(r.join("a/deep/low.txt"), b"1").unwrap();
        std::fs::write(r.join("b/top2.txt"), b"1").unwrap();
        std::fs::write(r.join("b/deep/low2.txt"), b"1").unwrap();
        let n = walk_names(r, &[("a", false), ("b", true)], &Filters::default());
        assert_eq!(n, vec!["low2.txt", "top.txt", "top2.txt"]);
    }

    #[test]
    fn filters_size_extension_dates() {
        let d = tempfile::tempdir().unwrap();
        let r = d.path();
        std::fs::write(r.join("small.zip"), b"1234").unwrap();
        std::fs::write(r.join("big.ZIP"), vec![0u8; 100]).unwrap();
        std::fs::write(r.join("doc.pdf"), b"12").unwrap();
        let all = |f: Filters| walk_names(r, &[("", true)], &f);
        assert_eq!(all(Filters::default()).len(), 3);
        let max = Filters {
            max_size: 10,
            ..Default::default()
        };
        assert_eq!(all(max), vec!["doc.pdf", "small.zip"]);
        let ext = Filters {
            extensions: vec![".zip".into(), "7z".into()],
            ..Default::default()
        };
        assert_eq!(all(ext), vec!["big.ZIP", "small.zip"]);
        // Everything here was just made, so a range in the past finds nothing, one around now all.
        let past = Filters {
            date_to: Some(1_000_000),
            ..Default::default()
        };
        assert!(all(past).is_empty());
        let now = Filters {
            date_from: Some(1_000_000),
            date_by: DateBy::Created,
            ..Default::default()
        };
        assert_eq!(all(now).len(), 3);
    }

    #[test]
    fn system_folders() {
        assert!(is_system_path("c:/windows"));
        assert!(is_system_path("c:/windows/system32/x.dll"));
        assert!(is_system_path("d:/program files (x86)/a"));
        assert!(is_system_path("c:/$recycle.bin/s-1"));
        assert!(!is_system_path("c:/users/kuno/windows"));
        assert!(!is_system_path("c:/windowsold/x"));
        assert!(!is_system_path("c:/"));
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("a.txt"), b"1").unwrap();
        let on = Filters {
            skip_system: true,
            ..Default::default()
        };
        // A temp folder is not a system folder, so skipping them leaves it alone.
        assert_eq!(walk_names(d.path(), &[("", true)], &on), vec!["a.txt"]);
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
