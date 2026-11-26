//! Sift's core: walking folders, telling what is old, finding duplicates. No window and no
//! Windows-only parts live here, so all of it can be tested anywhere.

pub mod dupes;
pub mod keep;
pub mod model;
pub mod names;
pub mod old;
pub mod presets;
pub mod scan;

use model::{FileEntry, ScanResult};
use rayon::prelude::*;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::AtomicBool;

/// Everything a scan is asked to do.
#[derive(Debug, Clone, Default)]
pub struct ScanRequest {
    /// In the job's order.
    pub folders: Vec<scan::ScanFolder>,
    pub skip: Vec<String>,
    /// Paths on the keep-list.
    pub keep: Vec<String>,
    /// Display names of installed programs.
    pub installed: Vec<String>,
    pub find_old: bool,
    pub find_dupes: bool,
    pub settings: presets::JobSettings,
    pub now: i64,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "phase", rename_all = "camelCase")]
pub enum Progress {
    Looking { files: u64 },
    Comparing { done: u64, total: u64 },
    Checking,
}

pub fn run(
    req: &ScanRequest,
    cache: &mut dupes::HashCache,
    cancel: &AtomicBool,
    progress: &(dyn Fn(Progress) + Sync),
    fresh: Option<&std::sync::Mutex<Vec<(String, dupes::Cached)>>>,
) -> ScanResult {
    let skip = scan::skip_matcher(&req.skip);
    let walked = scan::walk(&req.folders, &skip, &req.settings.filters(), cancel, |n| {
        progress(Progress::Looking { files: n })
    });
    let mut files = walked.files;
    let keep: HashSet<String> = req.keep.iter().map(|p| scan::norm_path(p)).collect();
    for f in &mut files {
        f.kept = keep.contains(&scan::norm_path(&f.path));
    }
    let mut result = ScanResult {
        started_at: req.now,
        folders: req.folders.iter().map(|f| f.path.clone()).collect(),
        stats: walked.stats,
        ..Default::default()
    };
    if cancel.load(std::sync::atomic::Ordering::Relaxed) {
        result.cancelled = true;
        return result;
    }

    // Duplicates are looked for when asked. Installer versions are needed for old downloads too
    // ("a newer version is here"), so names are compared either way; contents only for copies
    // and same-content groups.
    let kinds = &req.settings.kinds;
    let content = req.find_dupes && (kinds.copies || kinds.same_content);
    let mut dupe_settings = req.settings.dupes(content);
    if !req.find_dupes {
        dupe_settings.similar = 0;
    }
    let hashing = dupes::Hashing {
        cancel,
        progress: &|done, total| progress(Progress::Comparing { done, total }),
        fresh,
    };
    let (mut groups, hashed) = dupes::find(&files, &dupe_settings, cache, &hashing);
    result.stats.hashed_bytes = hashed;
    if cancel.load(std::sync::atomic::Ordering::Relaxed) {
        result.cancelled = true;
        return result;
    }
    progress(Progress::Checking);
    // A group made only of kept files has nothing to decide.
    groups.retain(|g| g.files.iter().any(|&i| !files[i as usize].kept));
    let installed = old::Installed::new(&req.installed);
    let old_items = if req.find_old {
        old::find(
            &files,
            &walked.dirs,
            &installed,
            &groups,
            &req.settings.old(),
            req.now,
        )
    } else {
        Vec::new()
    };
    if req.find_dupes {
        groups.retain(|g| kinds.wants(g.kind));
    } else {
        groups.clear();
    }

    // Keep only the files something points at, and say where each came from.
    let mut used: Vec<u32> = old_items.iter().map(|o| o.file).collect();
    used.extend(groups.iter().flat_map(|g| g.files.iter().copied()));
    used.sort();
    used.dedup();
    let origins: HashMap<u32, Option<(String, String)>> = used
        .par_iter()
        .map(|&id| (id, scan::read_origin(&files[id as usize].path)))
        .collect();
    let mut shown: Vec<FileEntry> = Vec::with_capacity(used.len());
    for id in used {
        let mut f = std::mem::replace(
            &mut files[id as usize],
            FileEntry {
                id,
                path: String::new(),
                dir: String::new(),
                name: String::new(),
                ext: String::new(),
                kind: model::Kind::Other,
                size: 0,
                modified: 0,
                created: 0,
                touched: 0,
                origin: None,
                origin_detail: None,
                kept: false,
            },
        );
        if let Some(Some((host, detail))) = origins.get(&id).cloned() {
            f.origin = Some(host);
            f.origin_detail = Some(detail);
        }
        shown.push(f);
    }
    result.files = shown;
    result.old = old_items;
    result.groups = groups;
    result.fill_keys();
    result
}

/// Looks at the files of a saved result on disk and drops every one that is gone or no longer
/// has the size and modified time the scan saw. Returns how many files were dropped.
pub fn recheck(result: &mut ScanResult) -> usize {
    let gone: HashSet<u32> = result
        .files
        .par_iter()
        .filter(|f| match std::fs::metadata(&f.path) {
            Ok(m) => !m.is_file() || m.len() != f.size || scan::secs(m.modified()) != f.modified,
            Err(_) => true,
        })
        .map(|f| f.id)
        .collect();
    result.remove_files(&gone);
    gone.len()
}

#[cfg(test)]
mod tests {
    use super::*;
    use presets::JobSettings;

    fn request(dir: &std::path::Path, find_old: bool, find_dupes: bool) -> ScanRequest {
        ScanRequest {
            folders: vec![scan::ScanFolder {
                path: dir.to_string_lossy().to_string(),
                recursive: true,
            }],
            find_old,
            find_dupes,
            settings: JobSettings {
                min_size: 1,
                ..Default::default()
            },
            now: 4_000_000_000,
            ..Default::default()
        }
    }

    fn go(req: &ScanRequest) -> ScanResult {
        run(
            req,
            &mut dupes::HashCache::new(),
            &AtomicBool::new(false),
            &|_| {},
            None,
        )
    }

    #[test]
    fn what_to_find_is_respected() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("a.pdf"), b"same bytes").unwrap();
        std::fs::write(d.path().join("a (1).pdf"), b"same bytes").unwrap();
        let both = go(&request(d.path(), true, true));
        assert_eq!(both.groups.len(), 1);
        assert!(!both.groups[0].key.is_empty());
        assert!(!both.old.is_empty());
        let dupes_only = go(&request(d.path(), false, true));
        assert_eq!(dupes_only.groups.len(), 1);
        assert!(dupes_only.old.is_empty());
        let old_only = go(&request(d.path(), true, false));
        assert!(old_only.groups.is_empty());
        assert_eq!(old_only.old.len(), 2);
        // Leaving a kind out drops those groups.
        let mut req = request(d.path(), false, true);
        req.settings.kinds.copies = false;
        assert!(go(&req).groups.is_empty());
    }

    #[test]
    fn recheck_drops_what_is_gone_or_changed() {
        let d = tempfile::tempdir().unwrap();
        for n in ["a.pdf", "b.pdf", "c.pdf"] {
            std::fs::write(d.path().join(n), b"same bytes").unwrap();
        }
        let mut r = go(&request(d.path(), true, true));
        assert_eq!(r.groups[0].files.len(), 3);
        assert_eq!(recheck(&mut r), 0);
        std::fs::remove_file(d.path().join("b.pdf")).unwrap();
        assert_eq!(recheck(&mut r), 1);
        assert_eq!(r.groups[0].files.len(), 2);
        assert!(r.old.iter().all(|o| r.files.iter().any(|f| f.id == o.file)));
        // Changing a file's size drops it too, and a group left with one file goes.
        std::fs::write(d.path().join("c.pdf"), b"other bytes now").unwrap();
        assert_eq!(recheck(&mut r), 1);
        assert!(r.groups.is_empty());
    }

    #[test]
    fn group_keys_follow_the_files() {
        let a = model::group_key(model::GroupKind::Copies, &["C:/B.pdf", "c:/a.pdf"]);
        let b = model::group_key(model::GroupKind::Copies, &["c:/a.pdf", "C:/b.PDF"]);
        assert_eq!(a, b);
        assert_ne!(
            a,
            model::group_key(model::GroupKind::SameContent, &["c:/a.pdf", "c:/b.pdf"])
        );
        assert_ne!(a, model::group_key(model::GroupKind::Copies, &["c:/a.pdf"]));
    }
}
