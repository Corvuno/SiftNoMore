//! What a scan finds and what Sift shows: files, their kind, why a file looks old, and groups of
//! duplicates. These are sent to the window as they are, so names are what the window reads.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Installer,
    Archive,
    Image,
    Document,
    Disk,
    Video,
    Audio,
    Torrent,
    Other,
}

impl Kind {
    pub fn of_ext(ext: &str) -> Kind {
        match ext {
            "exe" | "msi" | "msix" | "msixbundle" | "appx" | "appxbundle" => Kind::Installer,
            "zip" | "7z" | "rar" | "tar" | "gz" | "tgz" | "bz2" | "xz" | "zst" | "tar.gz"
            | "tar.bz2" | "tar.xz" | "tar.zst" | "cab" => Kind::Archive,
            "iso" | "img" | "vhd" | "vhdx" | "dmg" => Kind::Disk,
            "pdf" | "doc" | "docx" | "xls" | "xlsx" | "ppt" | "pptx" | "odt" | "ods" | "odp"
            | "rtf" | "txt" | "csv" | "epub" | "md" => Kind::Document,
            "jpg" | "jpeg" | "png" | "gif" | "bmp" | "webp" | "heic" | "tif" | "tiff" | "svg"
            | "raw" | "cr2" | "nef" | "ico" => Kind::Image,
            "mp4" | "mkv" | "avi" | "mov" | "wmv" | "webm" | "m4v" | "flv" => Kind::Video,
            "mp3" | "wav" | "flac" | "aac" | "ogg" | "m4a" | "wma" | "opus" => Kind::Audio,
            "torrent" => Kind::Torrent,
            _ => Kind::Other,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileEntry {
    pub id: u32,
    pub path: String,
    pub dir: String,
    pub name: String,
    pub ext: String,
    pub kind: Kind,
    pub size: u64,
    /// Seconds since 1970.
    pub modified: i64,
    /// When the file was created, seconds since 1970 (0 when Windows does not say).
    #[serde(default)]
    pub created: i64,
    /// The latest of created, modified and last opened: when the file was last touched at all.
    pub touched: i64,
    /// The website a download came from, read from the mark Windows puts on downloaded files.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin: Option<String>,
    /// The full addresses behind `origin`: the page it was downloaded from and the file's own
    /// address, as Windows recorded them.
    #[serde(
        default,
        rename = "originDetail",
        alias = "origin_detail",
        skip_serializing_if = "Option::is_none"
    )]
    pub origin_detail: Option<String>,
    /// On the keep-list: shown so a group makes sense, never suggested for removal.
    #[serde(default)]
    pub kept: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Signal {
    /// Not opened or changed for this many months.
    Untouched { months: u32 },
    /// An installer for a program that is already installed.
    Installed { program: String },
    /// An archive whose contents are already unpacked next to it.
    Unpacked { folder: String },
    /// An archive older than the archive limit.
    OldArchive { months: u32 },
    /// An installer for which a newer version is in the scan.
    Superseded { newer: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OldItem {
    pub file: u32,
    pub signals: Vec<Signal>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, PartialOrd, Ord)]
#[serde(rename_all = "camelCase")]
pub enum GroupKind {
    /// Duplicates: byte for byte the same, and the same name apart from copy marks
    /// ("setup.exe", "setup (1).exe", "report - Copy.pdf").
    Copies,
    /// Duplicates: versions of one installer ("vlc-3.0.18.exe", "vlc-3.0.20.exe").
    Versions,
    /// Not sure: byte for byte the same, but under unrelated names.
    SameContent,
    /// Not sure: the same name (copy marks aside), different content.
    SameName,
    /// Not sure: names that are nearly the same.
    SimilarName,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Group {
    pub kind: GroupKind,
    pub files: Vec<u32>,
    /// The file Sift would keep if asked to choose (newest version, or the one without a copy
    /// mark, or the oldest original). Just a suggestion; nothing is selected by it.
    pub suggested: u32,
    /// A short word for what ties the group: the shared name or product.
    pub label: String,
    /// For same-content groups: the MD5 fingerprint all files share, so it can be checked by hand
    /// (in Windows: certutil -hashfile <file> MD5).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fingerprint: Option<String>,
    /// A key that stays the same while the group has the same files: what is stored about a
    /// group (reviewed, ignored) is stored against it. See `group_key`.
    #[serde(default)]
    pub key: String,
    /// For copies and same-content groups: the file in the folder highest in the job's order,
    /// when that is one file alone (see `keep::apply_folder_picks`).
    #[serde(default, rename = "folderPick")]
    pub folder_pick: Option<u32>,
}

impl GroupKind {
    /// The name the window knows the kind by.
    pub fn name(self) -> &'static str {
        match self {
            GroupKind::Copies => "copies",
            GroupKind::Versions => "versions",
            GroupKind::SameContent => "sameContent",
            GroupKind::SameName => "sameName",
            GroupKind::SimilarName => "similarName",
        }
    }
}

/// A fingerprint of some text, as the keys stored about groups are made.
pub fn key_of_text(text: &str) -> String {
    use md5::{Digest, Md5};
    format!("{:x}", Md5::digest(text.as_bytes()))
}

/// The stable key of a group: its kind and the sorted, lower-cased paths of its files, hashed.
pub fn group_key(kind: GroupKind, paths: &[&str]) -> String {
    let mut p: Vec<String> = paths.iter().map(|p| p.to_lowercase()).collect();
    p.sort();
    key_of_text(&format!("{}:{}", kind.name(), p.join("|")))
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub files_seen: u64,
    pub bytes_seen: u64,
    pub folders_seen: u64,
    pub unreadable: u64,
    pub hashed_bytes: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    pub started_at: i64,
    pub finished_at: i64,
    pub folders: Vec<String>,
    /// Only the files that appear in `old` or `groups`.
    pub files: Vec<FileEntry>,
    pub old: Vec<OldItem>,
    pub groups: Vec<Group>,
    pub stats: Stats,
    pub cancelled: bool,
}

impl ScanResult {
    /// Gives every group its key (results saved by older versions have none).
    pub fn fill_keys(&mut self) {
        let by_id: std::collections::HashMap<u32, &str> =
            self.files.iter().map(|f| (f.id, f.path.as_str())).collect();
        for g in &mut self.groups {
            let paths: Vec<&str> = g
                .files
                .iter()
                .filter_map(|i| by_id.get(i).copied())
                .collect();
            g.key = group_key(g.kind, &paths);
        }
    }

    /// Takes files out of the result: from the lists, from groups (a group with fewer than two
    /// files goes), and the suggestion moves on when it was one of them.
    pub fn remove_files(&mut self, ids: &std::collections::HashSet<u32>) {
        if ids.is_empty() {
            return;
        }
        self.files.retain(|f| !ids.contains(&f.id));
        self.old.retain(|o| !ids.contains(&o.file));
        for g in self.groups.iter_mut() {
            g.files.retain(|i| !ids.contains(i));
            if ids.contains(&g.suggested) {
                if let Some(&first) = g.files.first() {
                    g.suggested = first;
                }
            }
        }
        self.groups.retain(|g| g.files.len() >= 2);
        self.fill_keys();
    }
}
