//! A job's settings, and the presets that fill them in. A preset holds what to find and how
//! (never folders); the user can also save their own, which the app keeps.

use crate::dupes::DupeSettings;
use crate::model::GroupKind;
use crate::old::OldSettings;
use crate::scan::{DateBy, Filters};
use serde::{Deserialize, Serialize};

/// Which kinds of duplicate groups to look for.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DupeKinds {
    pub copies: bool,
    pub versions: bool,
    pub same_content: bool,
    pub same_name: bool,
    pub similar_name: bool,
}

impl Default for DupeKinds {
    fn default() -> Self {
        DupeKinds {
            copies: true,
            versions: true,
            same_content: true,
            same_name: true,
            similar_name: true,
        }
    }
}

impl DupeKinds {
    pub fn wants(&self, k: GroupKind) -> bool {
        match k {
            GroupKind::Copies => self.copies,
            GroupKind::Versions => self.versions,
            GroupKind::SameContent => self.same_content,
            GroupKind::SameName => self.same_name,
            GroupKind::SimilarName => self.similar_name,
        }
    }
}

/// Every setting of a job. Sizes are bytes, dates seconds since 1970.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct JobSettings {
    pub untouched_months: u32,
    pub archive_months: u32,
    /// Duplicates: files smaller than this are left out.
    pub min_size: u64,
    /// Files larger than this are left out; 0 means no limit.
    pub max_size: u64,
    /// How alike two names must be to be "similar", in percent.
    pub similar: u32,
    pub date_by: DateBy,
    pub date_from: Option<i64>,
    pub date_to: Option<i64>,
    /// Only these extensions; empty means all.
    pub extensions: Vec<String>,
    pub skip_system: bool,
    pub kinds: DupeKinds,
}

impl Default for JobSettings {
    fn default() -> Self {
        JobSettings {
            untouched_months: 6,
            archive_months: 3,
            min_size: 1024,
            max_size: 0,
            similar: 95,
            date_by: DateBy::Modified,
            date_from: None,
            date_to: None,
            extensions: Vec::new(),
            skip_system: false,
            kinds: DupeKinds::default(),
        }
    }
}

impl JobSettings {
    pub fn old(&self) -> OldSettings {
        OldSettings {
            untouched_months: self.untouched_months,
            archive_months: self.archive_months,
        }
    }

    /// `content`: whether file contents are read (copies and same-content groups need it).
    pub fn dupes(&self, content: bool) -> DupeSettings {
        DupeSettings {
            min_size: self.min_size,
            similar: if self.kinds.similar_name {
                self.similar
            } else {
                0
            },
            read_content: content,
        }
    }

    pub fn filters(&self) -> Filters {
        Filters {
            max_size: self.max_size,
            extensions: self.extensions.clone(),
            date_by: self.date_by,
            date_from: self.date_from,
            date_to: self.date_to,
            skip_system: self.skip_system,
        }
    }
}

/// What a preset sets: the two "what to find" switches and every setting.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PresetValues {
    pub find_old: bool,
    pub find_dupes: bool,
    pub settings: JobSettings,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preset {
    pub id: String,
    pub name: String,
    pub description: String,
    #[serde(flatten)]
    pub values: PresetValues,
}

const MB: u64 = 1 << 20;

fn preset(
    id: &str,
    name: &str,
    description: &str,
    find_old: bool,
    find_dupes: bool,
    settings: JobSettings,
) -> Preset {
    Preset {
        id: id.into(),
        name: name.into(),
        description: description.into(),
        values: PresetValues {
            find_old,
            find_dupes,
            settings,
        },
    }
}

fn exts(list: &[&str]) -> Vec<String> {
    list.iter().map(|e| e.to_string()).collect()
}

/// The presets that come with Sift. They cannot be changed or deleted.
pub fn builtin() -> Vec<Preset> {
    let base = JobSettings::default;
    vec![
        preset(
            "quick",
            "Quick scan",
            "Old files and obvious copies, big files only. Fast: names and sizes first.",
            true,
            true,
            JobSettings {
                untouched_months: 12,
                archive_months: 6,
                min_size: MB,
                kinds: DupeKinds {
                    same_name: false,
                    similar_name: false,
                    ..DupeKinds::default()
                },
                ..base()
            },
        ),
        preset(
            "thorough",
            "Thorough clean",
            "Everything Sift can tell, small files too, and names that are only alike.",
            true,
            true,
            JobSettings {
                untouched_months: 6,
                archive_months: 3,
                min_size: 0,
                similar: 90,
                ..base()
            },
        ),
        preset(
            "obvious",
            "Obvious duplicates",
            "Only the same file twice, and older versions of one installer.",
            false,
            true,
            JobSettings {
                kinds: DupeKinds {
                    same_content: false,
                    same_name: false,
                    similar_name: false,
                    ..DupeKinds::default()
                },
                ..base()
            },
        ),
        preset(
            "deeper",
            "Deeper duplicates",
            "Also the same content under other names, the same name with other content, and similar names.",
            false,
            true,
            JobSettings {
                min_size: 0,
                similar: 88,
                ..base()
            },
        ),
        preset(
            "installers",
            "Installer leftovers",
            "Installers that are installed already, replaced by a newer version, or just old.",
            true,
            false,
            JobSettings {
                untouched_months: 3,
                archive_months: 3,
                extensions: exts(&["exe", "msi", "msix", "msixbundle", "appx", "appxbundle"]),
                ..base()
            },
        ),
        preset(
            "archives",
            "Old archives",
            "Zip, 7z, rar and the like that are old or already unpacked.",
            true,
            false,
            JobSettings {
                untouched_months: 12,
                archive_months: 6,
                extensions: exts(&[
                    "zip", "7z", "rar", "tar", "gz", "tgz", "bz2", "xz", "zst", "cab",
                ]),
                ..base()
            },
        ),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn builtin_presets_are_sound() {
        let all = builtin();
        assert_eq!(all.len(), 6);
        let ids: HashSet<&str> = all.iter().map(|p| p.id.as_str()).collect();
        assert_eq!(ids.len(), all.len());
        for p in &all {
            assert!(!p.name.is_empty() && !p.description.is_empty());
            assert!(p.values.find_old || p.values.find_dupes, "{}", p.id);
            // Program folders are not skipped by any preset.
            assert!(!p.values.settings.skip_system, "{}", p.id);
            let k = &p.values.settings.kinds;
            if p.values.find_dupes {
                assert!(k.copies || k.versions || k.same_content || k.same_name || k.similar_name);
            }
        }
        let find = |id: &str| all.iter().find(|p| p.id == id).unwrap().values.clone();
        assert!(find("installers").find_old && !find("installers").find_dupes);
        assert!(!find("obvious").find_old && find("obvious").find_dupes);
        assert!(find("quick").find_old && find("quick").find_dupes);
    }

    #[test]
    fn settings_round_trip_and_fill_gaps() {
        let s = JobSettings {
            max_size: 5,
            date_from: Some(10),
            ..Default::default()
        };
        let json = serde_json::to_string(&s).unwrap();
        assert!(json.contains("\"untouchedMonths\":6"));
        let back: JobSettings = serde_json::from_str(&json).unwrap();
        assert_eq!(back, s);
        // Older saved jobs lack newer settings: they get the defaults.
        let partial: JobSettings = serde_json::from_str("{\"maxSize\":7}").unwrap();
        assert_eq!(partial.max_size, 7);
        assert_eq!(partial.similar, 95);
    }

    #[test]
    fn kinds_switch_similar_off() {
        let mut s = JobSettings::default();
        s.kinds.similar_name = false;
        assert_eq!(s.dupes(true).similar, 0);
        assert!(s.kinds.wants(GroupKind::Copies));
        s.kinds.copies = false;
        assert!(!s.kinds.wants(GroupKind::Copies));
    }
}
