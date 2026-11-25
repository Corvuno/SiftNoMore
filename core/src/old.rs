//! What makes a file "old": every signal together, as the owner settled. Untouched for months,
//! an installer for a program that is installed, an archive already unpacked, an archive older
//! than the limit, an installer for which a newer version is here.

use crate::model::{FileEntry, Group, GroupKind, Kind, OldItem, Signal};
use crate::names;
use crate::scan::norm_path;
use std::collections::{HashMap, HashSet};
use std::path::Path;

#[derive(Debug, Clone)]
pub struct OldSettings {
    /// Untouched for at least this many months.
    pub untouched_months: u32,
    /// Archives older than this many months.
    pub archive_months: u32,
}

impl Default for OldSettings {
    fn default() -> Self {
        OldSettings {
            untouched_months: 6,
            archive_months: 3,
        }
    }
}

const MONTH: i64 = 30 * 24 * 3600 + 10 * 3600; // a mean month, near enough

fn months_since(t: i64, now: i64) -> u32 {
    if t <= 0 || now <= t {
        0
    } else {
        ((now - t) / MONTH) as u32
    }
}

/// The names of installed programs, ready to compare with installer names.
pub struct Installed {
    programs: Vec<(String, Vec<String>, String)>, // display name, words, first two words glued
}

fn words(s: &str) -> Vec<String> {
    s.to_lowercase()
        .split(|c: char| !c.is_alphanumeric() && c != '+')
        .filter(|w| !w.is_empty())
        .map(String::from)
        .collect()
}

impl Installed {
    pub fn new(display_names: &[String]) -> Self {
        let mut programs: Vec<(String, Vec<String>, String)> = display_names
            .iter()
            .filter(|n| !n.trim().is_empty())
            .map(|n| {
                let w = words(n);
                let glued = w.iter().take(2).cloned().collect::<String>();
                (n.trim().to_string(), w, glued)
            })
            .collect();
        // Shorter names first: "VLC media player" beats "VLC media player plugin pack".
        programs.sort_by_key(|p| p.1.len());
        Installed { programs }
    }

    /// The installed program an installer file belongs to, if any.
    pub fn match_installer(&self, file_name: &str) -> Option<String> {
        let p = names::parse(file_name);
        if !names::is_installer_ext(&p.ext) {
            return None;
        }
        let product: Vec<String> = match &p.product {
            Some(prod) => prod.split(' ').map(String::from).collect(),
            None => names::product_words(&p.base),
        };
        if product.is_empty() {
            return None;
        }
        let glued = product.concat();
        if glued.chars().count() < 2 {
            return None;
        }
        for (name, w, g) in &self.programs {
            let by_words = product.iter().all(|pw| {
                w.iter()
                    .any(|t| t == pw || (pw.len() >= 4 && t.starts_with(pw.as_str())))
            });
            // "7z" against "7-Zip": glued together the program name starts with it. Only for
            // names with a digit or of three letters or more, so "go" doesn't match "Google".
            let by_glue = (glued.len() >= 3 || glued.chars().any(|c| c.is_ascii_digit()))
                && g.starts_with(&glued)
                && glued.len() * 2 >= g.len();
            if by_words || by_glue {
                return Some(name.clone());
            }
        }
        None
    }
}

/// Is this archive already unpacked next to where it is? Yes when a folder with its name sits
/// beside it, or (for zip files) when what is inside it already exists on disk.
fn unpacked_into(f: &FileEntry, dirs: &HashSet<String>) -> Option<String> {
    let (stem, _) = names::split_ext(&f.name);
    let clean = names::parse(&f.name).base;
    for candidate in [stem.to_string(), clean] {
        let folder = Path::new(&f.dir).join(&candidate);
        if dirs.contains(&norm_path(&folder.to_string_lossy())) {
            return Some(folder.to_string_lossy().to_string());
        }
    }
    if f.ext == "zip" {
        return zip_contents_present(f);
    }
    None
}

fn zip_contents_present(f: &FileEntry) -> Option<String> {
    let file = std::fs::File::open(&f.path).ok()?;
    let mut zip = zip::ZipArchive::new(file).ok()?;
    let (stem, _) = names::split_ext(&f.name);
    let dir = Path::new(&f.dir);
    let mut names: Vec<String> = Vec::new();
    for i in 0..zip.len().min(400) {
        if let Ok(e) = zip.by_index_raw(i) {
            if !e.is_dir() {
                names.push(e.name().to_string());
            }
        }
    }
    if names.is_empty() {
        return None;
    }
    for base in [dir.to_path_buf(), dir.join(stem)] {
        let present = names
            .iter()
            .filter(|n| base.join(n.as_str()).is_file())
            .count();
        if present * 10 >= names.len() * 9 {
            return Some(base.to_string_lossy().to_string());
        }
    }
    None
}

pub fn find(
    files: &[FileEntry],
    dirs: &HashSet<String>,
    installed: &Installed,
    groups: &[Group],
    s: &OldSettings,
    now: i64,
) -> Vec<OldItem> {
    let mut superseded: HashMap<u32, String> = HashMap::new();
    for g in groups.iter().filter(|g| g.kind == GroupKind::Versions) {
        let newer = &files[g.suggested as usize];
        let newer_v = names::parse(&newer.name).version.unwrap_or_default();
        for &id in &g.files {
            let f = &files[id as usize];
            if f.kind != Kind::Installer || id == g.suggested {
                continue;
            }
            let v = names::parse(&f.name).version.unwrap_or_default();
            if names::cmp_version(&v, &newer_v) == std::cmp::Ordering::Less {
                superseded.insert(id, newer.name.clone());
            }
        }
    }

    let mut out = Vec::new();
    for f in files.iter().filter(|f| !f.kept) {
        let mut signals = Vec::new();
        let age = months_since(f.touched, now);
        if age >= s.untouched_months {
            signals.push(Signal::Untouched { months: age });
        }
        if f.kind == Kind::Installer {
            if let Some(program) = installed.match_installer(&f.name) {
                signals.push(Signal::Installed { program });
            }
            if let Some(newer) = superseded.get(&f.id) {
                signals.push(Signal::Superseded {
                    newer: newer.clone(),
                });
            }
        }
        if f.kind == Kind::Archive {
            if let Some(folder) = unpacked_into(f, dirs) {
                signals.push(Signal::Unpacked { folder });
            }
            let archive_age = months_since(f.modified.max(f.touched), now);
            if archive_age >= s.archive_months && age < s.untouched_months {
                signals.push(Signal::OldArchive {
                    months: archive_age,
                });
            }
        }
        if !signals.is_empty() {
            out.push(OldItem {
                file: f.id,
                signals,
            });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn installer_matching() {
        let inst = Installed::new(&[
            "Mozilla Firefox (x64 en-US)".into(),
            "Google Chrome".into(),
            "VLC media player".into(),
            "7-Zip 23.01 (x64)".into(),
            "Steam".into(),
            "Discord".into(),
        ]);
        assert_eq!(
            inst.match_installer("Firefox Setup 120.0.exe").as_deref(),
            Some("Mozilla Firefox (x64 en-US)")
        );
        assert_eq!(
            inst.match_installer("ChromeSetup.exe").as_deref(),
            Some("Google Chrome")
        );
        assert_eq!(
            inst.match_installer("vlc-3.0.20-win64.exe").as_deref(),
            Some("VLC media player")
        );
        assert_eq!(
            inst.match_installer("7z2301-x64.exe").as_deref(),
            Some("7-Zip 23.01 (x64)")
        );
        assert_eq!(
            inst.match_installer("SteamSetup (1).exe").as_deref(),
            Some("Steam")
        );
        assert_eq!(
            inst.match_installer("DiscordSetup.exe").as_deref(),
            Some("Discord")
        );
        assert_eq!(inst.match_installer("go1.21.5.windows-amd64.msi"), None);
        assert_eq!(inst.match_installer("Firefox.pdf"), None);
        assert_eq!(inst.match_installer("blender-4.0.2-windows-x64.msi"), None);
    }

    #[test]
    fn signals() {
        let d = tempfile::tempdir().unwrap();
        let dir = d.path().to_string_lossy().to_string();
        std::fs::create_dir(d.path().join("photos")).unwrap();
        let now = 1_800_000_000;
        let mk = |id: u32, name: &str, age_months: i64| {
            let (_, ext) = names::split_ext(name);
            FileEntry {
                id,
                path: format!("{dir}/{name}"),
                dir: dir.clone(),
                name: name.into(),
                kind: Kind::of_ext(&ext),
                ext,
                size: 10,
                modified: now - age_months * MONTH,
                touched: now - age_months * MONTH,
                origin: None,
                kept: false,
            }
        };
        let mut files = vec![
            mk(0, "photos.zip", 1),
            mk(1, "fresh.pdf", 1),
            mk(2, "old.pdf", 9),
            mk(3, "Steam Setup.exe", 0),
            mk(4, "vlc-3.0.18.exe", 0),
            mk(5, "vlc-3.0.20.exe", 0),
            mk(6, "backup.7z", 4),
            mk(7, "kept.pdf", 20),
        ];
        files[7].kept = true;
        let mut dirs = HashSet::new();
        dirs.insert(norm_path(&format!("{dir}/photos")));
        let groups = vec![Group {
            kind: GroupKind::Versions,
            files: vec![4, 5],
            suggested: 5,
            label: "vlc".into(),
        }];
        let inst = Installed::new(&["Steam".into()]);
        let old = find(&files, &dirs, &inst, &groups, &OldSettings::default(), now);
        let get = |id: u32| old.iter().find(|o| o.file == id).map(|o| o.signals.clone());
        assert!(matches!(get(0).unwrap()[0], Signal::Unpacked { .. }));
        assert_eq!(get(1), None);
        assert_eq!(get(2), Some(vec![Signal::Untouched { months: 9 }]));
        assert_eq!(
            get(3),
            Some(vec![Signal::Installed {
                program: "Steam".into()
            }])
        );
        assert_eq!(
            get(4),
            Some(vec![Signal::Superseded {
                newer: "vlc-3.0.20.exe".into()
            }])
        );
        assert_eq!(get(5), None);
        assert_eq!(get(6), Some(vec![Signal::OldArchive { months: 4 }]));
        assert_eq!(get(7), None);
    }

    #[test]
    fn zip_already_extracted() {
        use std::io::Write;
        let d = tempfile::tempdir().unwrap();
        let zp = d.path().join("pack.zip");
        {
            let mut z = zip::ZipWriter::new(std::fs::File::create(&zp).unwrap());
            let o = zip::write::SimpleFileOptions::default();
            z.start_file("a.txt", o).unwrap();
            z.write_all(b"a").unwrap();
            z.start_file("sub/b.txt", o).unwrap();
            z.write_all(b"b").unwrap();
            z.finish().unwrap();
        }
        let f = FileEntry {
            id: 0,
            path: zp.to_string_lossy().to_string(),
            dir: d.path().to_string_lossy().to_string(),
            name: "pack.zip".into(),
            ext: "zip".into(),
            kind: Kind::Archive,
            size: 1,
            modified: 0,
            touched: 0,
            origin: None,
            kept: false,
        };
        assert_eq!(zip_contents_present(&f), None);
        std::fs::create_dir_all(d.path().join("sub")).unwrap();
        std::fs::write(d.path().join("a.txt"), b"a").unwrap();
        std::fs::write(d.path().join("sub/b.txt"), b"b").unwrap();
        assert!(zip_contents_present(&f).is_some());
    }
}
