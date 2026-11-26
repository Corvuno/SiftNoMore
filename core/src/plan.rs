//! Planning the Act step: which file gets what. From the choices made per certainty level, the
//! files the filters show and what is selected, this works out who goes, who stays, where moved
//! files land (with " (2)" when a name is taken), which kept files are renamed to their clean
//! name, and the order things happen in. It touches nothing; the app does what the plan says.
//! The same plan is what the dry run shows and what Go carries out.

use crate::keep;
use crate::model::{FileEntry, GroupKind, ScanResult};
use crate::names;
use crate::scan::norm_path;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

/// Which file stays in a group.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Strategy {
    /// Nothing in these groups is touched.
    #[default]
    Leave,
    /// What is selected goes, the rest of the group stays.
    Selected,
    /// The copy in the folder highest in the job's order stays (identical files only).
    FolderOrder,
    Newest,
    Oldest,
    Largest,
}

/// What happens to the files that go.
#[derive(Debug, Clone, PartialEq, Default, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Removal {
    #[default]
    Recycle,
    Move {
        to: String,
        #[serde(rename = "keepStructure", default)]
        keep_structure: bool,
    },
    Delete,
}

/// A group the filters show, with the files of it that are shown.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct ShownGroup {
    pub key: String,
    pub files: Vec<u32>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ActRequest {
    /// Copies and installer versions.
    pub sure: Strategy,
    /// Same content under other names, same name, similar names.
    pub not_sure: Strategy,
    /// Old downloads: Leave or Selected only.
    pub old: Strategy,
    pub removal: Removal,
    /// Move the files that stay to this folder.
    pub move_kept: Option<String>,
    /// Rename the file that stays to its clean name.
    pub rename_kept: bool,
    /// What the filters show.
    pub shown_groups: Vec<ShownGroup>,
    pub shown_old: Vec<u32>,
    pub selected_dupes: Vec<u32>,
    pub selected_old: Vec<u32>,
    /// Files that may never go: protected by a pattern (kept files are known to the result).
    pub locked: Vec<u32>,
    /// Filled in by the app from the job.
    pub folder_order: Vec<String>,
    pub roots: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Level {
    Sure,
    NotSure,
    Old,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Fate {
    Stays,
    Recycle,
    Move,
    Delete,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub id: u32,
    pub path: String,
    pub level: Level,
    /// The group it belongs to (its label), for files that are in one.
    pub group: Option<String>,
    pub fate: Fate,
    /// Where it lands: for a file that goes with Move, and for a kept file moved on.
    pub moved_to: Option<String>,
    /// The path it has after being renamed to its clean name.
    pub renamed_to: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum OpKind {
    Recycle,
    Move,
    Rename,
    Delete,
}

/// One thing to do, in the order it is done.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Op {
    pub id: u32,
    pub kind: OpKind,
    pub from: String,
    pub to: Option<String>,
    /// Why, for History.
    pub reason: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Skip {
    pub id: u32,
    pub path: String,
    pub reason: String,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Totals {
    pub go: usize,
    pub go_bytes: u64,
    pub stay: usize,
    pub kept_moved: usize,
    pub renamed: usize,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub items: Vec<Item>,
    pub ops: Vec<Op>,
    /// Kept files whose clean name is taken: left as they are.
    pub skipped: Vec<Skip>,
    /// Groups the folder order could not decide (a tie, or no copy in a listed folder).
    pub undecided: usize,
    /// Groups in which every file would go.
    pub wiped: Vec<String>,
    pub totals: Totals,
}

fn sep_of(base: &str) -> char {
    if base.contains('\\') || base.chars().nth(1) == Some(':') {
        '\\'
    } else {
        '/'
    }
}

fn join(base: &str, rest: &str) -> String {
    let sep = sep_of(base);
    let base = base.trim_end_matches(['\\', '/']);
    let rest = rest.trim_matches(['\\', '/']);
    let rest = rest.replace(['\\', '/'], &sep.to_string());
    if rest.is_empty() {
        format!("{base}{sep}")
    } else {
        format!("{base}{sep}{rest}")
    }
}

/// The folder part of a path and its file name.
pub fn split_path(path: &str) -> (&str, &str) {
    match path.rfind(['\\', '/']) {
        Some(i) => (&path[..i], &path[i + 1..]),
        None => ("", path),
    }
}

/// The part of `dir` below `root`, "" when it is the root itself, None when `dir` is not in it.
fn below(dir: &str, root: &str) -> Option<String> {
    let d = dir.replace('\\', "/");
    let r = root.replace('\\', "/");
    let r = r.trim_end_matches('/');
    if d.to_lowercase() == r.to_lowercase() {
        return Some(String::new());
    }
    if d.len() > r.len()
        && d.is_char_boundary(r.len())
        && d[..r.len()].to_lowercase() == r.to_lowercase()
        && d[r.len()..].starts_with('/')
    {
        return Some(d[r.len() + 1..].to_string());
    }
    None
}

/// The folder of a path relative to the deepest of the roots that holds it.
fn structure_of(dir: &str, roots: &[String]) -> String {
    roots
        .iter()
        .filter_map(|r| below(dir, r).map(|rest| (r.len(), rest)))
        .max_by_key(|(len, _)| *len)
        .map(|(_, rest)| rest)
        .unwrap_or_default()
}

/// "report.pdf" with 2 gives "report (2).pdf".
pub fn numbered(name: &str, n: u32) -> String {
    let (stem, ext) = names::split_ext(name);
    if ext.is_empty() {
        format!("{stem} ({n})")
    } else {
        format!("{stem} ({n}).{}", &name[name.len() - ext.len()..])
    }
}

/// What the plan knows about names in use while it is made.
struct Names<'a> {
    exists: &'a dyn Fn(&str) -> bool,
    /// Paths the plan puts something at, normalised.
    taken: HashSet<String>,
    /// Paths the plan has emptied, normalised.
    vacated: HashSet<String>,
}

impl Names<'_> {
    fn busy(&self, path: &str) -> bool {
        let n = norm_path(path);
        self.taken.contains(&n) || ((self.exists)(path) && !self.vacated.contains(&n))
    }

    /// A path in `dir` for `name`, with " (2)", " (3)" when the name is busy.
    fn free(&mut self, dir: &str, name: &str) -> String {
        let mut path = join(dir, name);
        let mut n = 1;
        while self.busy(&path) {
            n += 1;
            path = join(dir, &numbered(name, n));
        }
        self.taken.insert(norm_path(&path));
        path
    }
}

/// The path a file gets in `dir` when it is moved there: the first free name. Also used by the
/// app when it really moves a file, because what is free may have changed since the plan.
pub fn free_path(dir: &str, name: &str, exists: &dyn Fn(&str) -> bool) -> String {
    let mut names = Names {
        exists,
        taken: HashSet::new(),
        vacated: HashSet::new(),
    };
    names.free(dir, name)
}

fn level_of(kind: GroupKind) -> Level {
    match kind {
        GroupKind::Copies | GroupKind::Versions => Level::Sure,
        _ => Level::NotSure,
    }
}

/// Newest, oldest or largest of some files; ties go to the higher folder, then the first.
fn pick_by(strategy: Strategy, files: &[&FileEntry], order: &[String]) -> Option<u32> {
    let key = |f: &FileEntry| -> i64 {
        match strategy {
            Strategy::Newest => f.modified,
            Strategy::Oldest => -f.modified,
            _ => f.size as i64,
        }
    };
    let rank = |f: &FileEntry| keep::folder_rank(&f.path, order).unwrap_or(usize::MAX);
    files
        .iter()
        .min_by(|a, b| {
            key(b)
                .cmp(&key(a))
                .then(rank(a).cmp(&rank(b)))
                .then(a.id.cmp(&b.id))
        })
        .map(|f| f.id)
}

/// Works out the plan. `exists` says whether a path is taken on disk.
pub fn build(result: &ScanResult, req: &ActRequest, exists: &dyn Fn(&str) -> bool) -> Plan {
    let by_id: HashMap<u32, &FileEntry> = result.files.iter().map(|f| (f.id, f)).collect();
    let groups: HashMap<&str, &crate::model::Group> =
        result.groups.iter().map(|g| (g.key.as_str(), g)).collect();
    let locked: HashSet<u32> = req
        .locked
        .iter()
        .copied()
        .chain(result.files.iter().filter(|f| f.kept).map(|f| f.id))
        .collect();
    let sel_dupes: HashSet<u32> = req.selected_dupes.iter().copied().collect();
    let sel_old: HashSet<u32> = req.selected_old.iter().copied().collect();

    // Who goes, in order, with the group it was in; who stays in a group that is acted on.
    let mut goes: Vec<(u32, Level, Option<usize>)> = Vec::new();
    let mut go_set: HashSet<u32> = HashSet::new();
    let mut stays: Vec<(u32, Level, usize)> = Vec::new();
    let mut acted: Vec<&crate::model::Group> = Vec::new();
    let mut undecided = 0;

    for sg in &req.shown_groups {
        let Some(&g) = groups.get(sg.key.as_str()) else {
            continue;
        };
        let level = level_of(g.kind);
        let strategy = if level == Level::Sure {
            req.sure
        } else {
            req.not_sure
        };
        if strategy == Strategy::Leave {
            continue;
        }
        let ids: Vec<u32> = sg
            .files
            .iter()
            .copied()
            .filter(|id| g.files.contains(id) && by_id.contains_key(id))
            .collect();
        let (remove, keepers): (Vec<u32>, Vec<u32>) = if strategy == Strategy::Selected {
            let remove: Vec<u32> = ids
                .iter()
                .copied()
                .filter(|id| sel_dupes.contains(id) && !locked.contains(id))
                .collect();
            let keepers = ids
                .iter()
                .copied()
                .filter(|id| !remove.contains(id) && !locked.contains(id))
                .collect();
            (remove, keepers)
        } else {
            if ids.len() < 2 {
                continue;
            }
            let files: Vec<&FileEntry> = ids.iter().map(|id| by_id[id]).collect();
            let keep_id = if ids.iter().any(|id| locked.contains(id)) {
                // A kept or protected file is the one that stays.
                None
            } else if strategy == Strategy::FolderOrder {
                let pick = if matches!(g.kind, GroupKind::Copies | GroupKind::SameContent) {
                    keep::pick_by_folder(&files, &req.folder_order)
                } else {
                    None
                };
                if pick.is_none() {
                    undecided += 1;
                    continue;
                }
                pick
            } else {
                pick_by(strategy, &files, &req.folder_order)
            };
            let remove: Vec<u32> = ids
                .iter()
                .copied()
                .filter(|id| Some(*id) != keep_id && !locked.contains(id))
                .collect();
            (remove, keep_id.into_iter().collect())
        };
        if remove.is_empty() {
            continue;
        }
        let gi = acted.len();
        acted.push(g);
        for id in remove {
            if go_set.insert(id) {
                goes.push((id, level, Some(gi)));
            }
        }
        for id in keepers {
            stays.push((id, level, gi));
        }
    }
    if req.old == Strategy::Selected {
        for &id in &req.shown_old {
            if sel_old.contains(&id)
                && !locked.contains(&id)
                && by_id.contains_key(&id)
                && go_set.insert(id)
            {
                goes.push((id, Level::Old, None));
            }
        }
    }
    // A file that goes in one place does not stay in another; one that stays in two groups is
    // planned once.
    let mut seen = HashSet::new();
    stays.retain(|(id, _, _)| !go_set.contains(id) && seen.insert(*id));

    let wiped: Vec<String> = result
        .groups
        .iter()
        .filter(|g| g.files.len() >= 2 && g.files.iter().all(|id| go_set.contains(id)))
        .map(|g| g.label.clone())
        .collect();

    let mut plan = Plan {
        undecided,
        wiped,
        ..Default::default()
    };
    let mut names = Names {
        exists,
        taken: HashSet::new(),
        vacated: HashSet::new(),
    };

    // 1. The files that go.
    for &(id, level, gi) in &goes {
        let f = by_id[&id];
        let group = gi.map(|i| acted[i].label.clone());
        let reason = match gi {
            Some(i) => format!("Duplicate: {}", acted[i].label),
            None => "Old download".to_string(),
        };
        let (fate, kind, to) = match &req.removal {
            Removal::Recycle => (Fate::Recycle, OpKind::Recycle, None),
            Removal::Delete => (Fate::Delete, OpKind::Delete, None),
            Removal::Move { to, keep_structure } => {
                let dir = if *keep_structure {
                    join(to, &structure_of(&f.dir, &req.roots))
                } else {
                    to.clone()
                };
                (Fate::Move, OpKind::Move, Some(names.free(&dir, &f.name)))
            }
        };
        names.vacated.insert(norm_path(&f.path));
        plan.ops.push(Op {
            id,
            kind,
            from: f.path.clone(),
            to: to.clone(),
            reason,
        });
        plan.items.push(Item {
            id,
            path: f.path.clone(),
            level,
            group,
            fate,
            moved_to: to,
            renamed_to: None,
        });
        plan.totals.go += 1;
        plan.totals.go_bytes += f.size;
    }

    // 2. The files that stay: moved on, then renamed to their clean name.
    let mut renames: Vec<Op> = Vec::new();
    for &(id, level, gi) in &stays {
        let f = by_id[&id];
        let mut item = Item {
            id,
            path: f.path.clone(),
            level,
            group: Some(acted[gi].label.clone()),
            fate: Fate::Stays,
            moved_to: None,
            renamed_to: None,
        };
        let mut here = f.path.clone();
        if let Some(dir) = &req.move_kept {
            let path = names.free(dir, &f.name);
            names.vacated.insert(norm_path(&f.path));
            plan.ops.push(Op {
                id,
                kind: OpKind::Move,
                from: f.path.clone(),
                to: Some(path.clone()),
                reason: format!("Kept file of {}", acted[gi].label),
            });
            plan.totals.kept_moved += 1;
            item.moved_to = Some(path.clone());
            here = path;
        }
        if req.rename_kept {
            let (dir, name) = split_path(&here);
            if let Some(clean) = names::clean_name(name) {
                let target = join(dir, &clean);
                if names.busy(&target) {
                    plan.skipped.push(Skip {
                        id,
                        path: f.path.clone(),
                        reason: format!("“{clean}” is already in that folder"),
                    });
                } else {
                    names.taken.insert(norm_path(&target));
                    names.vacated.insert(norm_path(&here));
                    renames.push(Op {
                        id,
                        kind: OpKind::Rename,
                        from: here,
                        to: Some(target.clone()),
                        reason: "Renamed to its clean name".to_string(),
                    });
                    plan.totals.renamed += 1;
                    item.renamed_to = Some(target);
                }
            }
        }
        plan.totals.stay += 1;
        plan.items.push(item);
    }
    plan.ops.extend(renames);
    plan
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Group, Kind};

    fn file(id: u32, path: &str, size: u64, modified: i64) -> FileEntry {
        let (dir, name) = split_path(path);
        FileEntry {
            id,
            path: path.into(),
            dir: dir.into(),
            name: name.into(),
            ext: "pdf".into(),
            kind: Kind::Document,
            size,
            modified,
            created: 0,
            touched: modified,
            origin: None,
            origin_detail: None,
            kept: false,
        }
    }

    fn group(key: &str, kind: GroupKind, files: Vec<u32>) -> Group {
        Group {
            kind,
            suggested: files[0],
            label: key.into(),
            files,
            fingerprint: None,
            key: key.into(),
            folder_pick: None,
        }
    }

    fn shown(result: &ScanResult) -> Vec<ShownGroup> {
        result
            .groups
            .iter()
            .map(|g| ShownGroup {
                key: g.key.clone(),
                files: g.files.clone(),
            })
            .collect()
    }

    fn none(_: &str) -> bool {
        false
    }

    fn two_copies() -> ScanResult {
        ScanResult {
            files: vec![
                file(0, "C:\\Down\\a.pdf", 10, 100),
                file(1, "D:\\Docs\\a.pdf", 10, 200),
            ],
            groups: vec![group("g", GroupKind::Copies, vec![0, 1])],
            ..Default::default()
        }
    }

    #[test]
    fn leave_alone_touches_nothing() {
        let r = two_copies();
        let req = ActRequest {
            shown_groups: shown(&r),
            selected_dupes: vec![0],
            ..Default::default()
        };
        let p = build(&r, &req, &none);
        assert!(p.items.is_empty() && p.ops.is_empty());
    }

    #[test]
    fn as_selected_removes_selected_and_keeps_the_rest() {
        let r = two_copies();
        let req = ActRequest {
            sure: Strategy::Selected,
            shown_groups: shown(&r),
            selected_dupes: vec![0],
            ..Default::default()
        };
        let p = build(&r, &req, &none);
        assert_eq!(p.ops.len(), 1);
        assert_eq!(p.ops[0].kind, OpKind::Recycle);
        assert_eq!(p.ops[0].from, "C:\\Down\\a.pdf");
        assert_eq!(p.items.len(), 2);
        assert_eq!(p.items[1].fate, Fate::Stays);
        assert_eq!((p.totals.go, p.totals.stay), (1, 1));
        assert!(p.wiped.is_empty());
    }

    #[test]
    fn selecting_everything_in_a_group_is_called_out() {
        let r = two_copies();
        let req = ActRequest {
            sure: Strategy::Selected,
            shown_groups: shown(&r),
            selected_dupes: vec![0, 1],
            ..Default::default()
        };
        assert_eq!(build(&r, &req, &none).wiped, vec!["g".to_string()]);
    }

    #[test]
    fn folder_order_keeps_the_top_folder_and_skips_ties() {
        let mut r = two_copies();
        r.files.push(file(2, "C:\\Down\\b.pdf", 10, 1));
        r.files.push(file(3, "C:\\Down\\sub\\b.pdf", 10, 2));
        r.groups.push(group("h", GroupKind::Copies, vec![2, 3]));
        let req = ActRequest {
            sure: Strategy::FolderOrder,
            shown_groups: shown(&r),
            folder_order: vec!["D:\\Docs".into(), "C:\\Down".into()],
            ..Default::default()
        };
        let p = build(&r, &req, &none);
        // Docs is above Down: the Docs copy stays. Both b files sit under Down: undecided.
        assert_eq!(p.ops.len(), 1);
        assert_eq!(p.ops[0].from, "C:\\Down\\a.pdf");
        assert_eq!(p.undecided, 1);
    }

    #[test]
    fn newest_chooses_among_the_files_shown_only() {
        let r = ScanResult {
            files: vec![
                file(0, "C:\\a\\x.pdf", 10, 100),
                file(1, "C:\\a\\x (1).pdf", 10, 200),
                file(2, "C:\\b\\x.pdf", 10, 900), // newest, but hidden by a filter
            ],
            groups: vec![group("g", GroupKind::Copies, vec![0, 1, 2])],
            ..Default::default()
        };
        let req = ActRequest {
            sure: Strategy::Newest,
            shown_groups: vec![ShownGroup {
                key: "g".into(),
                files: vec![0, 1],
            }],
            ..Default::default()
        };
        let p = build(&r, &req, &none);
        assert_eq!(p.ops.len(), 1);
        assert_eq!(p.ops[0].id, 0);
        // Hidden file 2 is neither removed nor kept by the plan.
        assert!(p.items.iter().all(|i| i.id != 2));
        let req = ActRequest {
            sure: Strategy::Oldest,
            ..req
        };
        assert_eq!(build(&r, &req, &none).ops[0].id, 1);
        let req = ActRequest {
            sure: Strategy::Largest,
            ..req
        };
        // Equal sizes: the first one stays.
        assert_eq!(build(&r, &req, &none).ops[0].id, 1);
    }

    #[test]
    fn kept_and_locked_files_never_go() {
        let mut r = two_copies();
        r.files[1].kept = true;
        let req = ActRequest {
            sure: Strategy::Newest,
            shown_groups: shown(&r),
            ..Default::default()
        };
        // File 1 is on the keep-list: it stays and the other one goes.
        let p = build(&r, &req, &none);
        assert_eq!(p.ops.iter().map(|o| o.id).collect::<Vec<_>>(), vec![0]);
        let req = ActRequest {
            sure: Strategy::Selected,
            shown_groups: shown(&r),
            selected_dupes: vec![0, 1],
            locked: vec![0],
            ..Default::default()
        };
        assert!(build(&r, &req, &none).ops.is_empty());
    }

    #[test]
    fn old_downloads_go_only_when_asked_and_selected() {
        let r = ScanResult {
            files: vec![
                file(0, "C:\\Down\\o.zip", 5, 1),
                file(1, "C:\\Down\\p.zip", 7, 1),
            ],
            ..Default::default()
        };
        let mut req = ActRequest {
            shown_old: vec![0, 1],
            selected_old: vec![1],
            ..Default::default()
        };
        assert!(build(&r, &req, &none).ops.is_empty());
        req.old = Strategy::Selected;
        let p = build(&r, &req, &none);
        assert_eq!(p.ops.len(), 1);
        assert_eq!(p.items[0].level, Level::Old);
        // A file the filters hide is not touched even when selected.
        req.shown_old = vec![0];
        assert!(build(&r, &req, &none).ops.is_empty());
    }

    #[test]
    fn move_recreates_folders_under_the_scan_folder_and_numbers_taken_names() {
        let r = ScanResult {
            files: vec![
                file(0, "C:\\Down\\sub\\deep\\a.pdf", 10, 1),
                file(1, "C:\\Down\\a.pdf", 10, 2),
                file(2, "C:\\Down\\sub\\a.pdf", 10, 3),
            ],
            groups: vec![group("g", GroupKind::Copies, vec![0, 1, 2])],
            ..Default::default()
        };
        let req = ActRequest {
            sure: Strategy::Selected,
            shown_groups: shown(&r),
            selected_dupes: vec![0, 1, 2],
            removal: Removal::Move {
                to: "E:\\Old".into(),
                keep_structure: true,
            },
            roots: vec!["C:\\Down".into(), "C:\\Down\\sub".into()],
            ..Default::default()
        };
        let p = build(&r, &req, &none);
        let to: Vec<_> = p.ops.iter().map(|o| o.to.clone().unwrap()).collect();
        // "sub" is itself a scan folder, so its files are relative to it.
        assert_eq!(to[0], "E:\\Old\\deep\\a.pdf");
        assert_eq!(to[1], "E:\\Old\\a.pdf");
        assert_eq!(to[2], "E:\\Old\\a (2).pdf");
        let flat = ActRequest {
            removal: Removal::Move {
                to: "E:\\Old".into(),
                keep_structure: false,
            },
            ..req
        };
        let p = build(&r, &flat, &|p: &str| p == "E:\\Old\\a.pdf");
        let to: Vec<_> = p.ops.iter().map(|o| o.to.clone().unwrap()).collect();
        assert_eq!(
            to,
            vec![
                "E:\\Old\\a (2).pdf",
                "E:\\Old\\a (3).pdf",
                "E:\\Old\\a (4).pdf"
            ]
        );
    }

    fn pair_named_one() -> ScanResult {
        ScanResult {
            files: vec![
                file(0, "C:\\Down\\report.pdf", 10, 1),
                file(1, "C:\\Down\\report (1).pdf", 10, 2),
            ],
            groups: vec![group("g", GroupKind::Copies, vec![0, 1])],
            ..Default::default()
        }
    }

    #[test]
    fn rename_kept_uses_the_name_the_removal_frees() {
        let r = pair_named_one();
        // The copy without a mark goes, the marked one stays and takes its name.
        let req = ActRequest {
            sure: Strategy::Selected,
            shown_groups: shown(&r),
            selected_dupes: vec![0],
            rename_kept: true,
            ..Default::default()
        };
        let on_disk = |p: &str| p == "C:\\Down\\report.pdf" || p == "C:\\Down\\report (1).pdf";
        let p = build(&r, &req, &on_disk);
        assert_eq!(p.ops.len(), 2);
        assert_eq!(p.ops[0].kind, OpKind::Recycle);
        assert_eq!(p.ops[1].kind, OpKind::Rename);
        assert_eq!(p.ops[1].to.as_deref(), Some("C:\\Down\\report.pdf"));
        assert_eq!(p.totals.renamed, 1);
        assert!(p.skipped.is_empty());
    }

    #[test]
    fn rename_kept_is_skipped_and_listed_when_the_clean_name_is_taken() {
        // "report.pdf" is another file that is not part of the plan.
        let r = ScanResult {
            files: vec![
                file(1, "C:\\Down\\report (1).pdf", 10, 2),
                file(2, "C:\\Down\\report (2).pdf", 10, 3),
            ],
            groups: vec![group("g", GroupKind::Copies, vec![1, 2])],
            ..Default::default()
        };
        let req = ActRequest {
            sure: Strategy::Selected,
            shown_groups: shown(&r),
            selected_dupes: vec![2],
            rename_kept: true,
            ..Default::default()
        };
        let on_disk = |p: &str| p == "C:\\Down\\report.pdf";
        let p = build(&r, &req, &on_disk);
        assert_eq!(p.ops.len(), 1);
        assert_eq!(p.skipped.len(), 1);
        assert_eq!(p.totals.renamed, 0);
        // With the name free it is renamed.
        let p = build(&r, &req, &none);
        assert_eq!(p.ops.last().unwrap().kind, OpKind::Rename);
    }

    #[test]
    fn kept_files_move_on_and_are_renamed_in_their_new_folder() {
        let r = pair_named_one();
        let req = ActRequest {
            sure: Strategy::Selected,
            shown_groups: shown(&r),
            selected_dupes: vec![0],
            move_kept: Some("E:\\Keep".into()),
            rename_kept: true,
            ..Default::default()
        };
        let p = build(&r, &req, &none);
        let kinds: Vec<_> = p.ops.iter().map(|o| o.kind).collect();
        assert_eq!(kinds, vec![OpKind::Recycle, OpKind::Move, OpKind::Rename]);
        assert_eq!(p.ops[1].to.as_deref(), Some("E:\\Keep\\report (1).pdf"));
        assert_eq!(p.ops[2].from, "E:\\Keep\\report (1).pdf");
        assert_eq!(p.ops[2].to.as_deref(), Some("E:\\Keep\\report.pdf"));
    }

    #[test]
    fn permanent_delete_is_planned_as_delete() {
        let r = two_copies();
        let req = ActRequest {
            sure: Strategy::Newest,
            shown_groups: shown(&r),
            removal: Removal::Delete,
            ..Default::default()
        };
        let p = build(&r, &req, &none);
        assert_eq!(p.ops.len(), 1);
        assert_eq!(p.ops[0].kind, OpKind::Delete);
        assert_eq!(p.items[0].fate, Fate::Delete);
    }

    #[test]
    fn paths_of_both_kinds_are_joined_and_numbered() {
        assert_eq!(join("/tmp/x/", "a/b"), "/tmp/x/a/b");
        assert_eq!(join("C:\\x", "a/b"), "C:\\x\\a\\b");
        assert_eq!(numbered("a.tar.gz", 2), "a (2).tar.gz");
        assert_eq!(
            free_path("/t", "a.pdf", &|p| p == "/t/a.pdf"),
            "/t/a (2).pdf"
        );
    }
}
