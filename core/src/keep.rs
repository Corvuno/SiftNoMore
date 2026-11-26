//! "Keep in order of folders": which copy stays, decided by where it sits in the job's folder
//! list. It only speaks for files that are byte for byte the same, and only when one file alone
//! sits in the highest folder.

use crate::model::{FileEntry, GroupKind, ScanResult};
use crate::scan::norm_path;
use std::collections::HashMap;

/// The place of a file in the folder order: the index of the deepest folder it sits in (0 is the
/// top of the list), or None when it sits in none of them.
pub fn folder_rank(path: &str, order: &[String]) -> Option<usize> {
    let p = norm_path(path);
    let mut best: Option<(usize, usize)> = None; // (folder length, index)
    for (i, folder) in order.iter().enumerate() {
        let f = norm_path(folder);
        let f = f.trim_end_matches('/');
        if p.len() > f.len() && p.starts_with(f) && p.as_bytes()[f.len()] == b'/' {
            if best.is_none_or(|(len, _)| f.len() > len) {
                best = Some((f.len(), i));
            }
        }
    }
    best.map(|(_, i)| i)
}

/// Among files that are byte for byte the same, the one the folder order says stays: the one
/// in the highest folder, when that is one file alone. None when no file sits in a listed
/// folder or the top folder holds more than one of them.
pub fn pick_by_folder(files: &[&FileEntry], order: &[String]) -> Option<u32> {
    let mut best: Option<(usize, u32)> = None;
    let mut tied = false;
    for f in files {
        let Some(rank) = folder_rank(&f.path, order) else {
            continue;
        };
        match best {
            Some((r, _)) if rank > r => {}
            Some((r, _)) if rank == r => tied = true,
            _ => {
                best = Some((rank, f.id));
                tied = false;
            }
        }
    }
    if tied {
        None
    } else {
        best.map(|(_, id)| id)
    }
}

/// For every group, the file the folder order says stays, or None when it decides nothing:
/// the group is not of identical files, or the top folder holds more than one of them, or none
/// of them sits in a listed folder.
pub fn folder_picks(result: &ScanResult, order: &[String]) -> Vec<Option<u32>> {
    let by_id: HashMap<u32, &FileEntry> = result.files.iter().map(|f| (f.id, f)).collect();
    result
        .groups
        .iter()
        .map(|g| {
            if !matches!(g.kind, GroupKind::Copies | GroupKind::SameContent) {
                return None;
            }
            let files: Vec<&FileEntry> = g
                .files
                .iter()
                .filter_map(|id| by_id.get(id).copied())
                .collect();
            pick_by_folder(&files, order)
        })
        .collect()
}

/// Writes the picks into the groups.
pub fn apply_folder_picks(result: &mut ScanResult, order: &[String]) {
    let picks = folder_picks(result, order);
    for (g, p) in result.groups.iter_mut().zip(picks) {
        g.folder_pick = p;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Group, Kind};

    fn file(id: u32, path: &str) -> FileEntry {
        FileEntry {
            id,
            path: path.into(),
            dir: String::new(),
            name: path.rsplit(['/', '\\']).next().unwrap().into(),
            ext: "pdf".into(),
            kind: Kind::Document,
            size: 10,
            modified: 0,
            created: 0,
            touched: 0,
            origin: None,
            origin_detail: None,
            kept: false,
        }
    }

    fn group(kind: GroupKind, files: Vec<u32>) -> Group {
        Group {
            kind,
            suggested: files[0],
            files,
            label: String::new(),
            fingerprint: None,
            key: String::new(),
            folder_pick: None,
        }
    }

    #[test]
    fn rank_is_the_deepest_listed_folder() {
        let order = vec!["D:\\Films".to_string(), "D:\\Films\\Old".to_string()];
        assert_eq!(folder_rank("D:\\Films\\a.mkv", &order), Some(0));
        assert_eq!(folder_rank("d:\\films\\old\\a.mkv", &order), Some(1));
        assert_eq!(folder_rank("D:\\FilmsX\\a.mkv", &order), None);
        assert_eq!(folder_rank("E:\\a.mkv", &order), None);
    }

    #[test]
    fn highest_folder_keeps_identical_copies() {
        let result = ScanResult {
            files: vec![
                file(0, "C:\\Down\\a.pdf"),
                file(1, "D:\\Docs\\a.pdf"),
                file(2, "C:\\Down\\b.pdf"),
                file(3, "C:\\Down\\sub\\b.pdf"),
                file(4, "X:\\none\\c.pdf"),
                file(5, "C:\\Down\\c.pdf"),
            ],
            groups: vec![
                group(GroupKind::Copies, vec![0, 1]),
                group(GroupKind::Copies, vec![2, 3]),
                group(GroupKind::SameName, vec![0, 1]),
                group(GroupKind::SameContent, vec![4, 5]),
            ],
            ..Default::default()
        };
        let order = vec!["D:\\Docs".to_string(), "C:\\Down".to_string()];
        let picks = folder_picks(&result, &order);
        // Docs is higher than Down, so its copy stays.
        assert_eq!(picks[0], Some(1));
        // Both sit under the same listed folder: it decides nothing.
        assert_eq!(picks[1], None);
        // Files that are not identical are not decided by folders.
        assert_eq!(picks[2], None);
        // A file outside every listed folder never beats one inside.
        assert_eq!(picks[3], Some(5));
        // Reversed order flips the first group.
        let rev: Vec<String> = order.iter().rev().cloned().collect();
        assert_eq!(folder_picks(&result, &rev)[0], Some(0));
    }
}
