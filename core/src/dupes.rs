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
            similar: 90,
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
) -> (Vec<Vec<u32>>, u64) {
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
    let mut out: Vec<Vec<u32>> = groups.into_values().filter(|g| g.len() > 1).collect();
    for g in &mut out {
        g.sort();
    }
    (out, read.load(Ordering::Relaxed))
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

    // 1. Same content.
    let (exact, hashed) = same_content(files, settings.min_size, cache, h);
    let mut exact_of: HashMap<u32, usize> = HashMap::new();
    for (gi, g) in exact.iter().enumerate() {
        for &id in g {
            exact_of.insert(id, gi);
        }
        // Keep the one without a copy mark; among those the oldest, which is the original.
        let suggested = *g
            .iter()
            .min_by_key(|&&i| {
                let f = &files[i as usize];
                (!f.kept, mark(i) != CopyMark::None, f.modified, f.path.len())
            })
            .unwrap();
        groups.push(Group {
            kind: crate::model::GroupKind::SameContent,
            files: g.clone(),
            suggested,
            label: group_label(files, suggested),
        });
    }
    // A name-based group that is wholly one same-content group says nothing new.
    let covered = |ids: &[u32]| -> bool {
        let first = exact_of.get(&ids[0]);
        first.is_some() && ids.iter().all(|i| exact_of.get(i) == first)
    };

    // 2. Copies by name: "setup.exe", "setup (1).exe", "setup - Copy.exe".
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
    let mut in_copies: HashSet<u32> = HashSet::new();
    for ids in by_base.values() {
        if ids.len() < 2 {
            continue;
        }
        let has_original = ids.iter().any(|&i| mark(i) == CopyMark::None);
        // A bare trailing number only counts as a copy mark when the unnumbered name is there.
        let members: Vec<u32> = ids
            .iter()
            .copied()
            .filter(|&i| mark(i) != CopyMark::Weak || has_original)
            .collect();
        let marked = members
            .iter()
            .filter(|&&i| mark(i) != CopyMark::None)
            .count();
        let strong = members
            .iter()
            .filter(|&&i| mark(i) == CopyMark::Strong)
            .count();
        let valid = members.len() >= 2 && ((has_original && marked >= 1) || strong >= 2);
        if !valid || covered(&members) {
            continue;
        }
        let mut members = members;
        members.sort();
        let suggested = *members
            .iter()
            .min_by_key(|&&i| (mark(i) != CopyMark::None, files[i as usize].modified))
            .unwrap();
        in_copies.extend(members.iter().copied());
        groups.push(Group {
            kind: GroupKind::Copies,
            label: group_label(files, suggested),
            files: members,
            suggested,
        });
    }

    // 3. Versions: same product and extension, different version numbers.
    let mut by_product: HashMap<(&str, &str), Vec<u32>> = HashMap::new();
    for f in files.iter().filter(|f| big_enough(f)) {
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
        });
    }

    // 4. The same name in different folders, content not all the same.
    let mut by_name: HashMap<String, Vec<u32>> = HashMap::new();
    for f in files.iter().filter(|f| big_enough(f)) {
        by_name.entry(f.name.to_lowercase()).or_default().push(f.id);
    }
    for (name, ids) in &by_name {
        if ids.len() < 2 || ids.len() > 12 || COMMON_NAMES.contains(&name.as_str()) || covered(ids)
        {
            continue;
        }
        let dirs: HashSet<String> = ids
            .iter()
            .map(|&i| files[i as usize].dir.to_lowercase())
            .collect();
        if dirs.len() < 2 {
            continue;
        }
        let mut ids = ids.clone();
        ids.sort();
        let suggested = newest(files, &ids);
        groups.push(Group {
            kind: GroupKind::SameName,
            label: group_label(files, suggested),
            files: ids,
            suggested,
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
                .all(|i| in_copies.contains(i) || versioned.contains(i))
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
        let exact: Vec<&Group> = g
            .iter()
            .filter(|g| g.kind == GroupKind::SameContent)
            .collect();
        assert_eq!(exact.len(), 2);
        let movies = exact.iter().find(|g| g.files.contains(&0)).unwrap();
        assert_eq!(movies.files, vec![0, 1]);
        // The one without "(1)" is kept, even though it is newer.
        assert_eq!(movies.suggested, 0);
        // movie.mkv + movie (1).mkv are all one exact group: no extra "copies" group.
        assert!(!g.iter().any(|g| g.kind == GroupKind::Copies));
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
            ("setup.exe", b"v1", 1),
            ("setup (1).exe", b"v2-different", 2),
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
        let copies: Vec<Vec<String>> = g
            .iter()
            .filter(|g| g.kind == GroupKind::Copies)
            .map(|g| names_of(&f, g))
            .collect();
        assert!(copies.contains(&vec!["setup.exe".into(), "setup (1).exe".into()]));
        assert!(copies.contains(&vec!["Report.pdf".into(), "Report - Copy.pdf".into()]));
        assert!(copies.contains(&vec!["photo 1.jpg".into(), "photo.jpg".into()]));
        assert!(copies.contains(&vec!["pack (1).zip".into(), "pack (2).zip".into()]));
        // "Chapter 2" and "Chapter 3" are a series, not copies, and not "similar" either.
        assert!(!g
            .iter()
            .any(|g| names_of(&f, g).contains(&"Chapter 2.pdf".to_string())));
        let setup = g
            .iter()
            .find(|g| g.kind == GroupKind::Copies && g.files.contains(&0))
            .unwrap();
        assert_eq!(setup.suggested, 0);
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
