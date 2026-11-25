//! Finding duplicates: byte-for-byte the same, copies by name ("setup (1).exe"), versions of the
//! same thing, the same name in different folders, and names that are nearly the same.

use crate::model::{FileEntry, Group, GroupKind};
use crate::names::{self, CopyMark, NameParts};
use md5::{Digest, Md5};
use rayon::prelude::*;
use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

#[derive(Debug, Clone)]
pub struct DupeSettings {
    /// Files smaller than this are left out of duplicates.
    pub min_size: u64,
    /// How alike two names must be to count as "similar", in percent. 0 turns it off.
    pub similar: u32,
}

impl Default for DupeSettings {
    fn default() -> Self {
        DupeSettings {
            min_size: 1024,
            similar: 95,
        }
    }
}

/// A file's content fingerprint remembered from an earlier scan, valid while size and modified
/// time stay the same. Saves reading big files again.
#[derive(Debug, Clone, PartialEq)]
pub struct Cached {
    pub size: u64,
    pub modified: i64,
    pub md5: String,
}

pub type HashCache = HashMap<String, Cached>;

const PARTIAL: usize = 64 * 1024;

fn md5_of(
    path: &str,
    limit: Option<usize>,
    cancel: &AtomicBool,
    read: &AtomicU64,
) -> Option<String> {
    let mut f = std::fs::File::open(path).ok()?;
    let mut h = Md5::new();
    let mut buf = vec![0u8; 256 * 1024];
    let mut total = 0usize;
    loop {
        if cancel.load(Ordering::Relaxed) {
            return None;
        }
        let want = match limit {
            Some(l) if l - total < buf.len() => l - total,
            _ => buf.len(),
        };
        if want == 0 {
            break;
        }
        let n = f.read(&mut buf[..want]).ok()?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
        total += n;
        read.fetch_add(n as u64, Ordering::Relaxed);
    }
    Some(format!("{:x}", h.finalize()))
}

pub struct Hashing<'a> {
    pub cancel: &'a AtomicBool,
    /// Called with (bytes read so far, bytes that may need reading).
    pub progress: &'a (dyn Fn(u64, u64) + Sync),
}

/// Byte-for-byte duplicates. Files are first grouped by size, then by a fingerprint of their
/// start, and only then read in full, so most files are never read at all.
fn same_content(
    files: &[FileEntry],
    min_size: u64,
    cache: &mut HashCache,
    h: &Hashing,
) -> (Vec<(Vec<u32>, String)>, u64) {
    let mut by_size: HashMap<u64, Vec<u32>> = HashMap::new();
    for f in files {
        if f.size >= min_size.max(1) {
            by_size.entry(f.size).or_default().push(f.id);
        }
    }
    let candidates: Vec<u32> = by_size
        .values()
        .filter(|v| v.len() > 1)
        .flatten()
        .copied()
        .collect();
    let total: u64 = candidates.iter().map(|&i| files[i as usize].size).sum();
    let read = AtomicU64::new(0);
    let report = || (h.progress)(read.load(Ordering::Relaxed), total);

    // Stage 1: a full fingerprint from the cache, or a quick one of the first part.
    let stage1: Vec<(u32, Option<String>, bool)> = candidates
        .par_iter()
        .map(|&id| {
            let f = &files[id as usize];
            if let Some(c) = cache.get(&f.path) {
                if c.size == f.size && c.modified == f.modified {
                    read.fetch_add(f.size, Ordering::Relaxed);
                    return (id, Some(c.md5.clone()), true);
                }
            }
            if f.size as usize <= PARTIAL {
                let r = md5_of(&f.path, None, h.cancel, &read);
                return (id, r, true);
            }
            let r = md5_of(&f.path, Some(PARTIAL), h.cancel, &read);
            (id, r, false)
        })
        .collect();
    report();

    let mut full: HashMap<u32, String> = HashMap::new();
    let mut need_full: HashMap<(u64, String), Vec<u32>> = HashMap::new();
    for (id, hash, is_full) in stage1 {
        let Some(hash) = hash else { continue };
        if is_full {
            full.insert(id, hash);
        } else {
            need_full
                .entry((files[id as usize].size, hash))
                .or_default()
                .push(id);
        }
    }
    // A file whose quick fingerprint matches only cached full ones still needs its full one.
    let mut by_full_size: HashMap<u64, usize> = HashMap::new();
    for id in full.keys() {
        *by_full_size.entry(files[*id as usize].size).or_default() += 1;
    }
    let to_read: Vec<u32> = need_full
        .iter()
        .filter(|((size, _), ids)| {
            ids.len() > 1 || by_full_size.get(size).copied().unwrap_or(0) > 0
        })
        .flat_map(|(_, ids)| ids.iter().copied())
        .collect();
    let stage2: Vec<(u32, Option<String>)> = to_read
        .par_iter()
        .map(|&id| {
            let f = &files[id as usize];
            let r = md5_of(&f.path, None, h.cancel, &read);
            report();
            (id, r)
        })
        .collect();
    for (id, hash) in stage2 {
        if let Some(hash) = hash {
            full.insert(id, hash);
        }
    }
    report();

    let mut groups: HashMap<(u64, String), Vec<u32>> = HashMap::new();
    for (id, hash) in &full {
        let f = &files[*id as usize];
        cache.insert(
            f.path.clone(),
            Cached {
                size: f.size,
                modified: f.modified,
                md5: hash.clone(),
            },
        );
        groups.entry((f.size, hash.clone())).or_default().push(*id);
    }
    // Fingerprints matching is near-certain; comparing the bytes makes it certain. Every file in
    // a group is compared with the first, and any that differ split off into their own group.
    let candidates: Vec<((u64, String), Vec<u32>)> =
        groups.into_iter().filter(|(_, g)| g.len() > 1).collect();
    let mut out: Vec<(Vec<u32>, String)> = candidates
        .into_par_iter()
        .flat_map_iter(|((_, md5), mut ids)| {
            ids.sort();
            let mut verified = Vec::new();
            while ids.len() > 1 {
                let first = ids[0];
                let (same, rest): (Vec<u32>, Vec<u32>) = ids.iter().partition(|&&i| {
                    i == first
                        || same_bytes(
                            &files[first as usize].path,
                            &files[i as usize].path,
                            h.cancel,
                        )
                });
                if same.len() > 1 {
                    verified.push((same, md5.clone()));
                }
                ids = rest;
            }
            verified
        })
        .collect();
    out.sort();
    (out, read.load(Ordering::Relaxed))
}

/// True when both files hold exactly the same bytes.
fn same_bytes(a: &str, b: &str, cancel: &AtomicBool) -> bool {
    let (Ok(mut fa), Ok(mut fb)) = (std::fs::File::open(a), std::fs::File::open(b)) else {
        return false;
    };
    let mut ba = vec![0u8; 256 * 1024];
    let mut bb = vec![0u8; 256 * 1024];
    loop {
        if cancel.load(Ordering::Relaxed) {
            return false;
        }
        let na = match read_full(&mut fa, &mut ba) {
            Some(n) => n,
            None => return false,
        };
        let nb = match read_full(&mut fb, &mut bb) {
            Some(n) => n,
            None => return false,
        };
        if na != nb || ba[..na] != bb[..nb] {
            return false;
        }
        if na == 0 {
            return true;
        }
    }
}

fn read_full(f: &mut std::fs::File, buf: &mut [u8]) -> Option<usize> {
    let mut n = 0;
    while n < buf.len() {
        match f.read(&mut buf[n..]) {
            Ok(0) => break,
            Ok(k) => n += k,
            Err(_) => return None,
        }
    }
    Some(n)
}

/// Names so common that the same name in two folders means nothing.
const COMMON_NAMES: &[&str] = &[
    "desktop.ini",
    "thumbs.db",
    "readme",
    "readme.txt",
    "readme.md",
    "license",
    "license.txt",
    "license.md",
    "index.html",
    "index.js",
    "setup.exe",
    "install.exe",
    "uninstall.exe",
    "unins000.exe",
    "unins000.dat",
    ".ds_store",
    "icon.ico",
    "folder.jpg",
    "cover.jpg",
    "changelog.txt",
    "changelog.md",
    "manifest.json",
    "package.json",
    "config.json",
    "settings.json",
    "data.json",
    "image.png",
    "image.jpg",
    "untitled.png",
    "document.pdf",
];

fn newest(files: &[FileEntry], ids: &[u32]) -> u32 {
    *ids.iter()
        .max_by_key(|&&i| {
            (
                files[i as usize].modified,
                std::cmp::Reverse(files[i as usize].path.len()),
            )
        })
        .unwrap()
}

fn group_label(files: &[FileEntry], id: u32) -> String {
    files[id as usize].name.clone()
}

/// Two names are a numbered series (IMG_0001, IMG_0002; Chapter 2, Chapter 3), not duplicates,
/// when they are the same once their digits are taken out.
fn only_digits_differ(a: &str, b: &str) -> bool {
    let strip = |s: &str| {
        s.chars()
            .filter(|c| !c.is_ascii_digit())
            .collect::<String>()
    };
    strip(a) == strip(b)
}

pub fn find(
    files: &[FileEntry],
    settings: &DupeSettings,
    cache: &mut HashCache,
    h: &Hashing,
) -> (Vec<Group>, u64) {
    let parts: Vec<NameParts> = files.iter().map(|f| names::parse(&f.name)).collect();
    let mark = |i: u32| parts[i as usize].mark;
    let big_enough = |f: &FileEntry| f.size >= settings.min_size;

    let mut groups: Vec<Group> = Vec::new();

    // What a person calls a duplicate: the same bytes AND the same name, where the name may
    // carry a copy mark ("setup.exe", "setup (1).exe", "setup - Copy.exe"). Same bytes under
    // unrelated names, or the same name with other bytes, are shown apart as "not sure".
    let base_key = |i: u32| {
        (
            parts[i as usize].base.as_str(),
            parts[i as usize].ext.as_str(),
        )
    };
    let original_first = |i: &u32| {
        let f = &files[*i as usize];
        (
            !f.kept,
            mark(*i) != CopyMark::None,
            f.modified,
            f.path.len(),
        )
    };

    // 1. Copies: same content, same name. 2. Same content under other names.
    let (exact, hashed) = same_content(files, settings.min_size, cache, h);
    let mut exact_of: HashMap<u32, usize> = HashMap::new();
    for (gi, (g, md5)) in exact.iter().enumerate() {
        for &id in g {
            exact_of.insert(id, gi);
        }
        let mut by_name: HashMap<(&str, &str), Vec<u32>> = HashMap::new();
        for &id in g {
            by_name.entry(base_key(id)).or_default().push(id);
        }
        for ids in by_name.values().filter(|ids| ids.len() >= 2) {
            let suggested = *ids.iter().min_by_key(|i| original_first(i)).unwrap();
            groups.push(Group {
                kind: GroupKind::Copies,
                files: ids.clone(),
                suggested,
                label: group_label(files, suggested),
                fingerprint: Some(md5.clone()),
            });
        }
        if by_name.len() == 1 {
            continue;
        }
        {
            let suggested = *g.iter().min_by_key(|i| original_first(i)).unwrap();
            groups.push(Group {
                kind: GroupKind::SameContent,
                files: g.clone(),
                suggested,
                label: group_label(files, suggested),
                fingerprint: Some(md5.clone()),
            });
        }
    }
    // A name-based group that is wholly one same-content group says nothing new.
    let covered = |ids: &[u32]| -> bool {
        let first = exact_of.get(&ids[0]);
        first.is_some() && ids.iter().all(|i| exact_of.get(i) == first)
    };

    // 3. Versions of one installer: same program, different version numbers.
    let mut by_product: HashMap<(&str, &str), Vec<u32>> = HashMap::new();
    for f in files
        .iter()
        .filter(|f| big_enough(f) && f.kind == crate::model::Kind::Installer)
    {
        let p = &parts[f.id as usize];
        if let (Some(prod), Some(_)) = (&p.product, &p.version) {
            by_product
                .entry((prod.as_str(), p.ext.as_str()))
                .or_default()
                .push(f.id);
        }
    }
    let mut versioned: HashSet<u32> = HashSet::new();
    for ((prod, _), ids) in &by_product {
        let distinct: HashSet<&Vec<u64>> = ids
            .iter()
            .map(|&i| parts[i as usize].version.as_ref().unwrap())
            .collect();
        if distinct.len() < 2 || covered(ids) {
            continue;
        }
        let mut ids = ids.clone();
        ids.sort();
        let suggested = *ids
            .iter()
            .max_by(|&&a, &&b| {
                let va = parts[a as usize].version.as_ref().unwrap();
                let vb = parts[b as usize].version.as_ref().unwrap();
                names::cmp_version(va, vb)
                    .then(mark(b).cmp(&mark(a)))
                    .then(files[a as usize].modified.cmp(&files[b as usize].modified))
            })
            .unwrap();
        versioned.extend(ids.iter().copied());
        groups.push(Group {
            kind: GroupKind::Versions,
            files: ids,
            suggested,
            label: prod.to_string(),
            fingerprint: None,
        });
    }

    // 4. The same name (copy marks aside) with other content: "report.docx" here and there, or
    //    "report (1).docx" that was changed later.
    let mut by_base: HashMap<(&str, &str), Vec<u32>> = HashMap::new();
    for f in files.iter().filter(|f| big_enough(f)) {
        let p = &parts[f.id as usize];
        if p.base.chars().count() >= 2 {
            by_base
                .entry((p.base.as_str(), p.ext.as_str()))
                .or_default()
                .push(f.id);
        }
    }
    let mut in_same_name: HashSet<u32> = HashSet::new();
    for ids in by_base.values() {
        if ids.len() < 2 || ids.len() > 12 {
            continue;
        }
        let name = files[ids[0] as usize].name.to_lowercase();
        if COMMON_NAMES.contains(&name.as_str()) {
            continue;
        }
        let has_original = ids.iter().any(|&i| mark(i) == CopyMark::None);
        // A bare trailing number ("report 2") only counts as a copy mark when the unnumbered
        // name is there too; otherwise "Chapter 2" and "Chapter 3" would be one name.
        let mut members: Vec<u32> = ids
            .iter()
            .copied()
            .filter(|&i| mark(i) != CopyMark::Weak || has_original)
            .collect();
        if members.len() < 2 || covered(&members) {
            continue;
        }
        let dirs: HashSet<String> = members
            .iter()
            .map(|&i| files[i as usize].dir.to_lowercase())
            .collect();
        let marked = members.iter().any(|&i| mark(i) != CopyMark::None);
        if dirs.len() < 2 && !marked {
            continue;
        }
        members.sort();
        let suggested = newest(files, &members);
        in_same_name.extend(members.iter().copied());
        groups.push(Group {
            kind: GroupKind::SameName,
            label: group_label(files, suggested),
            files: members,
            suggested,
            fingerprint: None,
        });
    }

    // 5. Nearly the same name. Names are sorted so alike ones sit close together, and each is
    //    compared with a few neighbours only: that keeps it fast with very many files.
    if settings.similar > 0 {
        let threshold = settings.similar.min(100) as f64 / 100.0;
        let mut bases: Vec<(&str, &str)> = by_base
            .keys()
            .filter(|(b, _)| b.chars().count() >= 4)
            .copied()
            .collect();
        bases.sort_by(|a, b| a.1.cmp(b.1).then(a.0.cmp(b.0)));
        let mut parent: Vec<usize> = (0..bases.len()).collect();
        fn find_root(p: &mut [usize], mut i: usize) -> usize {
            while p[i] != i {
                p[i] = p[p[i]];
                i = p[i];
            }
            i
        }
        const WINDOW: usize = 12;
        for i in 0..bases.len() {
            for j in (i + 1)..bases.len().min(i + 1 + WINDOW) {
                if bases[i].1 != bases[j].1 {
                    break;
                }
                let (a, b) = (bases[i].0, bases[j].0);
                if only_digits_differ(a, b) {
                    continue;
                }
                if strsim::jaro_winkler(a, b) >= threshold {
                    let (ra, rb) = (find_root(&mut parent, i), find_root(&mut parent, j));
                    if ra != rb {
                        parent[ra] = rb;
                    }
                }
            }
        }
        let mut clusters: HashMap<usize, Vec<usize>> = HashMap::new();
        for i in 0..bases.len() {
            let r = find_root(&mut parent, i);
            clusters.entry(r).or_default().push(i);
        }
        for members in clusters.values().filter(|m| m.len() >= 2 && m.len() <= 8) {
            let mut ids: Vec<u32> = members
                .iter()
                .flat_map(|&bi| by_base.get(&bases[bi]).cloned().unwrap_or_default())
                .collect();
            // Already told as copies or versions: nothing new to say.
            if ids
                .iter()
                .all(|i| in_same_name.contains(i) || versioned.contains(i))
                || covered(&ids)
            {
                continue;
            }
            if ids.len() > 12 {
                continue;
            }
            ids.sort();
            let suggested = newest(files, &ids);
            groups.push(Group {
                kind: GroupKind::SimilarName,
                label: group_label(files, suggested),
                files: ids,
                suggested,
                fingerprint: None,
            });
        }
    }

    groups.sort_by(|a, b| a.kind.cmp(&b.kind).then(a.label.cmp(&b.label)));
    (groups, hashed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Kind;

    struct Fixture {
        _dir: tempfile::TempDir,
        files: Vec<FileEntry>,
    }

    /// (relative path, content, modified)
    fn fixture(spec: &[(&str, &[u8], i64)]) -> Fixture {
        let d = tempfile::tempdir().unwrap();
        let mut files = Vec::new();
        for (i, (rel, content, modified)) in spec.iter().enumerate() {
            let p = d.path().join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(&p, content).unwrap();
            let name = p.file_name().unwrap().to_string_lossy().to_string();
            let (_, ext) = names::split_ext(&name);
            files.push(FileEntry {
                id: i as u32,
                path: p.to_string_lossy().to_string(),
                dir: p.parent().unwrap().to_string_lossy().to_string(),
                kind: Kind::of_ext(&ext),
                name,
                ext,
                size: content.len() as u64,
                modified: *modified,
                touched: *modified,
                origin: None,
                origin_detail: None,
                kept: false,
            });
        }
        Fixture { _dir: d, files }
    }

    fn run(f: &Fixture, s: DupeSettings) -> Vec<Group> {
        let cancel = AtomicBool::new(false);
        let h = Hashing {
            cancel: &cancel,
            progress: &|_, _| {},
        };
        find(&f.files, &s, &mut HashCache::new(), &h).0
    }

    fn names_of(f: &Fixture, g: &Group) -> Vec<String> {
        g.files
            .iter()
            .map(|&i| f.files[i as usize].name.clone())
            .collect()
    }

    const S: DupeSettings = DupeSettings {
        min_size: 1,
        similar: 90,
    };

    #[test]
    fn exact_duplicates_and_suggestion() {
        let big = vec![7u8; 200_000];
        let mut other = big.clone();
        other[150_000] = 8; // same start, same size, different further on
        let f = fixture(&[
            ("a/movie.mkv", &big, 100),
            ("b/movie (1).mkv", &big, 50),
            ("c/film.mkv", &other, 10),
            ("d/notes.txt", b"hello", 10),
            ("e/notes2.txt", b"hello", 20),
        ]);
        let g = run(&f, S);
        // Same bytes and the same name (copy mark aside): a duplicate.
        let copies: Vec<&Group> = g.iter().filter(|g| g.kind == GroupKind::Copies).collect();
        assert_eq!(copies.len(), 1);
        assert_eq!(copies[0].files, vec![0, 1]);
        assert!(copies[0].fingerprint.is_some());
        // The one without "(1)" is kept, even though it is newer.
        assert_eq!(copies[0].suggested, 0);
        // Same bytes, unrelated names: shown apart as "not sure", never as a copy.
        let other: Vec<&Group> = g
            .iter()
            .filter(|g| g.kind == GroupKind::SameContent)
            .collect();
        assert_eq!(other.len(), 1);
        assert_eq!(names_of(&f, other[0]), vec!["notes.txt", "notes2.txt"]);
        // film.mkv differs further on: in no content group.
        assert!(!g
            .iter()
            .any(|g| g.files.contains(&2) && g.fingerprint.is_some()));
    }

    #[test]
    fn mixed_names_with_same_content() {
        // A GitHub download and a renamed mirror copy of it, plus a "(1)" copy.
        let f = fixture(&[
            ("WindowsClient.zip", b"same-bytes", 1),
            ("WindowsClient (1).zip", b"same-bytes", 2),
            ("0.9.5 ValheimPlus Windows Client-4.zip", b"same-bytes", 3),
        ]);
        let g = run(&f, S);
        let copies: Vec<&Group> = g.iter().filter(|g| g.kind == GroupKind::Copies).collect();
        assert_eq!(copies.len(), 1);
        assert_eq!(copies[0].files, vec![0, 1]);
        let other: Vec<&Group> = g
            .iter()
            .filter(|g| g.kind == GroupKind::SameContent)
            .collect();
        assert_eq!(other.len(), 1);
        assert_eq!(other[0].files, vec![0, 1, 2]);
    }

    #[test]
    fn cache_is_used_and_filled() {
        let f = fixture(&[("a/x.bin", b"same-same", 5), ("b/y.bin", b"same-same", 5)]);
        let cancel = AtomicBool::new(false);
        let h = Hashing {
            cancel: &cancel,
            progress: &|_, _| {},
        };
        let mut cache = HashCache::new();
        let (g, _) = find(&f.files, &S, &mut cache, &h);
        assert_eq!(g.len(), 1);
        assert_eq!(cache.len(), 2);
        // A cached fingerprint that says they differ wins over reading again.
        cache.get_mut(&f.files[1].path).unwrap().md5 = "different".into();
        let (g, _) = find(&f.files, &S, &mut cache, &h);
        assert!(g.iter().all(|g| g.kind != GroupKind::SameContent));
    }

    #[test]
    fn copies_by_name() {
        let f = fixture(&[
            ("tool.exe", b"v1", 1),
            ("tool (1).exe", b"v2-different", 2),
            ("Report.pdf", b"aaa", 1),
            ("Report - Copy.pdf", b"bbbb", 2),
            ("Chapter 2.pdf", b"c2", 1),
            ("Chapter 3.pdf", b"c3x", 1),
            ("photo 1.jpg", b"p1", 1),
            ("photo.jpg", b"p0x", 1),
            ("pack (1).zip", b"x1", 1),
            ("pack (2).zip", b"x2x", 1),
        ]);
        let g = run(&f, S);
        // Different content: never a duplicate, only "same name" in the not-sure part.
        assert!(!g.iter().any(|g| g.kind == GroupKind::Copies));
        let copies: Vec<Vec<String>> = g
            .iter()
            .filter(|g| g.kind == GroupKind::SameName)
            .map(|g| names_of(&f, g))
            .collect();
        assert!(copies.contains(&vec!["tool.exe".into(), "tool (1).exe".into()]));
        assert!(copies.contains(&vec!["Report.pdf".into(), "Report - Copy.pdf".into()]));
        assert!(copies.contains(&vec!["photo 1.jpg".into(), "photo.jpg".into()]));
        assert!(copies.contains(&vec!["pack (1).zip".into(), "pack (2).zip".into()]));
        // "Chapter 2" and "Chapter 3" are a series, not copies, and not "similar" either.
        assert!(!g
            .iter()
            .any(|g| names_of(&f, g).contains(&"Chapter 2.pdf".to_string())));
        let setup = g
            .iter()
            .find(|g| g.kind == GroupKind::SameName && g.files.contains(&0))
            .unwrap();
        assert_eq!(setup.files, vec![0, 1]);
    }

    #[test]
    fn versions() {
        let f = fixture(&[
            ("vlc-3.0.18-win64.exe", b"a", 1),
            ("vlc-3.0.20-win64.exe", b"bb", 2),
            ("vlc-3.0.9-win64.exe", b"ccc", 3),
            ("7z2301-x64.exe", b"dddd", 1),
            ("7z2408-x64.exe", b"eeeee", 1),
        ]);
        let g = run(&f, S);
        let vlc = g
            .iter()
            .find(|g| g.kind == GroupKind::Versions && g.label == "vlc")
            .unwrap();
        assert_eq!(vlc.files.len(), 3);
        assert_eq!(f.files[vlc.suggested as usize].name, "vlc-3.0.20-win64.exe");
        let sz = g
            .iter()
            .find(|g| g.kind == GroupKind::Versions && g.label == "7z")
            .unwrap();
        assert_eq!(f.files[sz.suggested as usize].name, "7z2408-x64.exe");
    }

    #[test]
    fn same_name_and_similar() {
        let f = fixture(&[
            ("a/invoice-march.pdf", b"1", 1),
            ("b/invoice-march.pdf", b"22", 2),
            ("a/holiday-pictures-italy.zip", b"333", 1),
            ("b/holiday-pictures-itaIy.zip", b"4444", 1),
            ("a/desktop.ini", b"x", 1),
            ("b/desktop.ini", b"yy", 1),
            ("IMG_0001.jpg", b"i1", 1),
            ("IMG_0002.jpg", b"i22", 1),
        ]);
        let g = run(&f, S);
        let same = g.iter().find(|g| g.kind == GroupKind::SameName).unwrap();
        assert_eq!(
            names_of(&f, same),
            vec!["invoice-march.pdf", "invoice-march.pdf"]
        );
        assert_eq!(same.suggested, 1);
        assert!(!g.iter().any(|g| g.label == "desktop.ini"));
        let sim: Vec<_> = g
            .iter()
            .filter(|g| g.kind == GroupKind::SimilarName)
            .collect();
        assert_eq!(sim.len(), 1, "{:?}", sim);
        assert!(names_of(&f, sim[0])
            .iter()
            .all(|n| n.starts_with("holiday")));
        // Off means off.
        let g = run(
            &f,
            DupeSettings {
                min_size: 1,
                similar: 0,
            },
        );
        assert!(!g.iter().any(|g| g.kind == GroupKind::SimilarName));
    }

    #[test]
    fn same_size_and_extension_is_not_enough() {
        // Like a program's preset files: same size, same extension, different bytes.
        let mut a = vec![1u8; 45_000];
        let mut b = a.clone();
        b[44_999] = 2;
        let mut c = vec![1u8; 70_000]; // past the quick-fingerprint length
        let mut d = c.clone();
        d[69_999] = 9;
        a[0] = 5;
        b[0] = 5;
        c[0] = 5;
        d[0] = 5;
        let f = fixture(&[
            ("1008543.fpmcp", &a, 1),
            ("1097040.fpmcp", &b, 1),
            ("1040667.fpmcp", &c, 1),
            ("1229421.fpmcp", &d, 1),
        ]);
        assert!(run(&f, S).iter().all(|g| g.fingerprint.is_none()));
    }

    #[test]
    fn bytes_are_compared_even_when_fingerprints_agree() {
        let f = fixture(&[("a/x.bin", b"aaaa-1", 5), ("b/y.bin", b"aaaa-2", 5)]);
        let cancel = AtomicBool::new(false);
        let h = Hashing {
            cancel: &cancel,
            progress: &|_, _| {},
        };
        let mut cache = HashCache::new();
        for file in &f.files {
            let c = Cached {
                size: file.size,
                modified: file.modified,
                md5: "same".into(),
            };
            cache.insert(file.path.clone(), c);
        }
        let (g, _) = find(&f.files, &S, &mut cache, &h);
        assert!(g.iter().all(|g| g.fingerprint.is_none()));
    }

    #[test]
    fn small_files_left_out() {
        let f = fixture(&[("a.txt", b"hi", 1), ("b.txt", b"hi", 1)]);
        assert!(run(
            &f,
            DupeSettings {
                min_size: 1024,
                similar: 0
            }
        )
        .is_empty());
    }
}
