//! Sift's core: walking folders, telling what is old, finding duplicates. No window and no
//! Windows-only parts live here, so all of it can be tested anywhere.

pub mod dupes;
pub mod model;
pub mod names;
pub mod old;
pub mod scan;

use model::{FileEntry, ScanResult};
use rayon::prelude::*;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::AtomicBool;

/// Everything a scan is asked to do.
#[derive(Debug, Clone, Default)]
pub struct ScanRequest {
    pub folders: Vec<String>,
    pub skip: Vec<String>,
    /// Paths on the keep-list.
    pub keep: Vec<String>,
    /// Display names of installed programs.
    pub installed: Vec<String>,
    pub old: old::OldSettings,
    pub dupes: dupes::DupeSettings,
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
) -> ScanResult {
    let skip = scan::skip_matcher(&req.skip);
    let walked = scan::walk(&req.folders, &skip, cancel, |n| {
        progress(Progress::Looking { files: n })
    });
    let mut files = walked.files;
    let keep: HashSet<String> = req.keep.iter().map(|p| scan::norm_path(p)).collect();
    for f in &mut files {
        f.kept = keep.contains(&scan::norm_path(&f.path));
    }
    let mut result = ScanResult {
        started_at: req.now,
        folders: req.folders.clone(),
        stats: walked.stats,
        ..Default::default()
    };
    if cancel.load(std::sync::atomic::Ordering::Relaxed) {
        result.cancelled = true;
        return result;
    }

    let hashing = dupes::Hashing {
        cancel,
        progress: &|done, total| progress(Progress::Comparing { done, total }),
    };
    let (mut groups, hashed) = dupes::find(&files, &req.dupes, cache, &hashing);
    result.stats.hashed_bytes = hashed;
    if cancel.load(std::sync::atomic::Ordering::Relaxed) {
        result.cancelled = true;
        return result;
    }
    progress(Progress::Checking);
    // A group made only of kept files has nothing to decide.
    groups.retain(|g| g.files.iter().any(|&i| !files[i as usize].kept));
    let installed = old::Installed::new(&req.installed);
    let old_items = old::find(&files, &walked.dirs, &installed, &groups, &req.old, req.now);

    // Keep only the files something points at, and say where each came from.
    let mut used: Vec<u32> = old_items.iter().map(|o| o.file).collect();
    used.extend(groups.iter().flat_map(|g| g.files.iter().copied()));
    used.sort();
    used.dedup();
    let origins: HashMap<u32, Option<String>> = used
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
                touched: 0,
                origin: None,
                kept: false,
            },
        );
        f.origin = origins.get(&id).cloned().flatten();
        shown.push(f);
    }
    result.files = shown;
    result.old = old_items;
    result.groups = groups;
    result
}
