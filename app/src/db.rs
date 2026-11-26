//! What Sift remembers between runs, in one SQLite file in the user's app-data folder: settings,
//! the pool of folders, jobs (each with its folders, settings and saved result), own presets,
//! skip patterns, the keep-list, content fingerprints, the scan history and the log of what went
//! to the Recycle Bin.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sift_core::dupes::{Cached, HashCache};
use sift_core::presets::{JobSettings, PresetValues};
use std::collections::HashMap;
use std::path::Path;

pub struct Db {
    conn: Connection,
}

/// One folder of the pool as a job sees it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct JobFolder {
    pub path: String,
    /// Ticked: this job looks in it.
    pub active: bool,
    /// Include subfolders.
    pub recursive: bool,
}

impl Default for JobFolder {
    fn default() -> Self {
        JobFolder {
            path: String::new(),
            active: false,
            recursive: true,
        }
    }
}

/// A job: a folder mix and settings. Every pool folder is listed, in the job's own order.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Job {
    pub id: i64,
    pub name: String,
    pub folders: Vec<JobFolder>,
    pub find_old: bool,
    pub find_dupes: bool,
    /// The preset the settings were last set from.
    pub preset: Option<String>,
    pub settings: JobSettings,
    /// Which step is open: setup, results or act.
    pub step: String,
    /// Which result list is open: old or dupes.
    pub list: String,
}

impl Default for Job {
    fn default() -> Self {
        Job {
            id: 0,
            name: String::new(),
            folders: Vec::new(),
            find_old: true,
            find_dupes: true,
            preset: None,
            settings: JobSettings::default(),
            step: "setup".into(),
            list: "old".into(),
        }
    }
}

impl Job {
    /// The active folders, in the job's order.
    pub fn active_folders(&self) -> Vec<&JobFolder> {
        self.folders.iter().filter(|f| f.active).collect()
    }
}

/// What the window needs to show a job's tab without opening its result.
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct JobCounts {
    pub old: i64,
    pub groups: i64,
    pub finished_at: i64,
    pub reviewed: i64,
}

/// A preset the user saved.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserPreset {
    pub id: String,
    pub name: String,
    #[serde(flatten)]
    pub values: PresetValues,
}

/// What is remembered about a job's result besides the result itself, kept by file path and
/// group key so it survives a new scan.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct JobState {
    pub sel_old: Vec<String>,
    pub sel_dupes: Vec<String>,
    pub reviewed: Vec<String>,
    pub ignored: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanRecord {
    pub id: i64,
    pub started_at: i64,
    pub finished_at: i64,
    pub folders: String,
    pub files_seen: i64,
    pub bytes_seen: i64,
    pub old_count: i64,
    pub group_count: i64,
    pub cancelled: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Removal {
    pub id: i64,
    pub at: i64,
    /// What was done: "recycled", "moved", "renamed" or "deleted".
    pub kind: String,
    /// Where the file was.
    pub path: String,
    /// Where it went (moved, renamed); nothing for recycled and deleted.
    pub to: Option<String>,
    pub size: i64,
    pub reason: String,
    /// When it was undone.
    pub restored_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Kept {
    pub path: String,
    pub at: i64,
}

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS folders (path TEXT PRIMARY KEY COLLATE NOCASE, enabled INTEGER NOT NULL DEFAULT 1, added_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS skip (pattern TEXT PRIMARY KEY COLLATE NOCASE);
CREATE TABLE IF NOT EXISTS keep (path TEXT PRIMARY KEY COLLATE NOCASE, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS hashes (path TEXT PRIMARY KEY COLLATE NOCASE, size INTEGER NOT NULL, modified INTEGER NOT NULL, md5 TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS scans (id INTEGER PRIMARY KEY, started_at INTEGER, finished_at INTEGER, folders TEXT, files_seen INTEGER, bytes_seen INTEGER, old_count INTEGER, group_count INTEGER, cancelled INTEGER);
CREATE TABLE IF NOT EXISTS removals (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, path TEXT NOT NULL, size INTEGER NOT NULL, reason TEXT NOT NULL, restored_at INTEGER);
CREATE TABLE IF NOT EXISTS last_result (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS jobs (id INTEGER PRIMARY KEY, position INTEGER NOT NULL, name TEXT NOT NULL, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS job_results (job_id INTEGER PRIMARY KEY, result TEXT, state TEXT NOT NULL DEFAULT '{}', old_count INTEGER NOT NULL DEFAULT 0, group_count INTEGER NOT NULL DEFAULT 0, finished_at INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS presets (id INTEGER PRIMARY KEY, name TEXT NOT NULL, json TEXT NOT NULL);
";

/// Folders and patterns nobody wants scanned, put in on first start. The user can remove them.
const DEFAULT_SKIP: &[&str] = &[
    "*\\node_modules",
    "*\\.git",
    "*\\$RECYCLE.BIN",
    "*\\System Volume Information",
];

impl Db {
    pub fn open(path: &Path) -> rusqlite::Result<Db> {
        let conn = Connection::open(path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.execute_batch(SCHEMA)?;
        let db = Db { conn };
        if db.setting("initialised")?.is_none() {
            for p in DEFAULT_SKIP {
                db.conn
                    .execute("INSERT OR IGNORE INTO skip (pattern) VALUES (?1)", [p])?;
            }
            if let Some(dl) = dirs::download_dir() {
                db.add_folder(&dl.to_string_lossy())?;
            }
            db.set_setting("initialised", "1")?;
        }
        db.migrate_to_jobs()?;
        db.add_history_columns()?;
        Ok(db)
    }

    /// History used to hold only what went to the Recycle Bin; now it holds moves, renames and
    /// permanent deletes too, each with its kind and where it went.
    fn add_history_columns(&self) -> rusqlite::Result<()> {
        let mut st = self.conn.prepare("PRAGMA table_info(removals)")?;
        let cols: Vec<String> = st
            .query_map([], |r| r.get::<_, String>(1))?
            .collect::<Result<_, _>>()?;
        drop(st);
        if !cols.iter().any(|c| c == "kind") {
            self.conn.execute_batch(
                "ALTER TABLE removals ADD COLUMN kind TEXT NOT NULL DEFAULT 'recycled';
                 ALTER TABLE removals ADD COLUMN dest TEXT;",
            )?;
        }
        Ok(())
    }

    /// The first time jobs exist: one job, "Downloads", takes over the folders, settings and last
    /// result that Sift had before jobs.
    fn migrate_to_jobs(&self) -> rusqlite::Result<()> {
        let n: i64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM jobs", [], |r| r.get(0))?;
        if n > 0 {
            return Ok(());
        }
        let num = |key: &str, default: u64| {
            self.setting(key)
                .ok()
                .flatten()
                .and_then(|v| v.parse::<u64>().ok())
                .unwrap_or(default)
        };
        let mut st = self
            .conn
            .prepare("SELECT path, enabled FROM folders ORDER BY added_at")?;
        let folders: Vec<JobFolder> = st
            .query_map([], |r| {
                Ok(JobFolder {
                    path: r.get(0)?,
                    active: r.get::<_, i64>(1)? != 0,
                    recursive: true,
                })
            })?
            .collect::<Result<_, _>>()?;
        drop(st);
        let result = self.load_result()?;
        let defaults = JobSettings::default();
        let job = Job {
            name: "Downloads".into(),
            folders,
            settings: JobSettings {
                untouched_months: num("untouchedMonths", defaults.untouched_months as u64) as u32,
                archive_months: num("archiveMonths", defaults.archive_months as u64) as u32,
                min_size: num("minDupeSize", defaults.min_size),
                similar: num("similarNames", defaults.similar as u64) as u32,
                ..defaults
            },
            step: if result.is_some() { "results" } else { "setup" }.into(),
            ..Default::default()
        };
        let id = self.create_job(&job)?;
        if let Some(json) = result {
            // What was marked "not duplicates" before is kept: the key is made the same way.
            let ignored: Vec<String> = self
                .setting("dismissed")?
                .and_then(|v| serde_json::from_str::<Vec<String>>(&v).ok())
                .unwrap_or_default()
                .iter()
                .map(|k| sift_core::model::key_of_text(k))
                .collect();
            let state = JobState {
                ignored,
                ..Default::default()
            };
            let (old, groups, finished) =
                serde_json::from_str::<sift_core::model::ScanResult>(&json)
                    .map(|r| (r.old.len() as i64, main_groups(&r), r.finished_at))
                    .unwrap_or_default();
            self.save_job_result(
                id,
                &json,
                &serde_json::to_string(&state).unwrap_or_else(|_| "{}".into()),
                old,
                groups,
                finished,
            )?;
        }
        self.set_setting("activeJob", &id.to_string())?;
        Ok(())
    }

    // ----- Jobs -----

    fn parse_job(id: i64, name: String, json: String) -> Job {
        let mut j: Job = serde_json::from_str(&json).unwrap_or_default();
        j.id = id;
        j.name = name;
        j
    }

    pub fn jobs(&self) -> rusqlite::Result<Vec<Job>> {
        let mut st = self
            .conn
            .prepare("SELECT id, name, json FROM jobs ORDER BY position, id")?;
        let rows = st.query_map([], |r| Ok(Db::parse_job(r.get(0)?, r.get(1)?, r.get(2)?)))?;
        rows.collect()
    }

    pub fn job(&self, id: i64) -> rusqlite::Result<Option<Job>> {
        self.conn
            .query_row("SELECT id, name, json FROM jobs WHERE id = ?1", [id], |r| {
                Ok(Db::parse_job(r.get(0)?, r.get(1)?, r.get(2)?))
            })
            .optional()
    }

    pub fn create_job(&self, job: &Job) -> rusqlite::Result<i64> {
        let pos: i64 =
            self.conn
                .query_row("SELECT COALESCE(MAX(position), 0) + 1 FROM jobs", [], |r| {
                    r.get(0)
                })?;
        let json = serde_json::to_string(job).unwrap_or_else(|_| "{}".into());
        self.conn.execute(
            "INSERT INTO jobs (position, name, json) VALUES (?1, ?2, ?3)",
            params![pos, job.name, json],
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    pub fn save_job(&self, job: &Job) -> rusqlite::Result<()> {
        let json = serde_json::to_string(job).unwrap_or_else(|_| "{}".into());
        self.conn.execute(
            "UPDATE jobs SET name = ?2, json = ?3 WHERE id = ?1",
            params![job.id, job.name, json],
        )?;
        Ok(())
    }

    pub fn delete_job(&self, id: i64) -> rusqlite::Result<()> {
        self.conn.execute("DELETE FROM jobs WHERE id = ?1", [id])?;
        self.conn
            .execute("DELETE FROM job_results WHERE job_id = ?1", [id])?;
        Ok(())
    }

    /// Adds folders to the pool and to every job (ticked only in `job_id`). A folder the pool
    /// has already is only ticked there.
    pub fn add_job_folders(&self, job_id: i64, paths: &[String]) -> rusqlite::Result<()> {
        for path in paths {
            self.add_folder(path)?;
            for mut job in self.jobs()? {
                let have = job
                    .folders
                    .iter()
                    .position(|f| f.path.eq_ignore_ascii_case(path));
                match have {
                    Some(i) if job.id == job_id => job.folders[i].active = true,
                    Some(_) => continue,
                    None => job.folders.push(JobFolder {
                        path: path.clone(),
                        active: job.id == job_id,
                        recursive: true,
                    }),
                }
                self.save_job(&job)?;
            }
        }
        Ok(())
    }

    /// Takes a folder out of the pool and out of every job.
    pub fn remove_pool_folder(&self, path: &str) -> rusqlite::Result<()> {
        self.remove_folder(path)?;
        for mut job in self.jobs()? {
            let before = job.folders.len();
            job.folders.retain(|f| !f.path.eq_ignore_ascii_case(path));
            if job.folders.len() != before {
                self.save_job(&job)?;
            }
        }
        Ok(())
    }

    pub fn pool(&self) -> rusqlite::Result<Vec<String>> {
        let mut st = self
            .conn
            .prepare("SELECT path FROM folders ORDER BY added_at, rowid")?;
        let rows = st.query_map([], |r| r.get(0))?;
        rows.collect()
    }

    // ----- Job results -----

    pub fn save_job_result(
        &self,
        job_id: i64,
        result: &str,
        state: &str,
        old: i64,
        groups: i64,
        finished_at: i64,
    ) -> rusqlite::Result<()> {
        self.conn.execute(
            "INSERT INTO job_results (job_id, result, state, old_count, group_count, finished_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(job_id) DO UPDATE SET result = ?2, state = ?3, old_count = ?4, group_count = ?5, finished_at = ?6",
            params![job_id, result, state, old, groups, finished_at],
        )?;
        Ok(())
    }

    pub fn save_job_state(&self, job_id: i64, state: &str) -> rusqlite::Result<()> {
        self.conn.execute(
            "INSERT INTO job_results (job_id, state) VALUES (?1, ?2) ON CONFLICT(job_id) DO UPDATE SET state = ?2",
            params![job_id, state],
        )?;
        Ok(())
    }

    /// The saved result (as JSON text) and state of a job.
    pub fn job_result(&self, job_id: i64) -> rusqlite::Result<(Option<String>, JobState)> {
        let row: Option<(Option<String>, String)> = self
            .conn
            .query_row(
                "SELECT result, state FROM job_results WHERE job_id = ?1",
                [job_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        Ok(match row {
            Some((res, state)) => (res, serde_json::from_str(&state).unwrap_or_default()),
            None => (None, JobState::default()),
        })
    }

    pub fn job_counts(&self) -> rusqlite::Result<HashMap<i64, JobCounts>> {
        let mut st = self.conn.prepare(
            "SELECT job_id, old_count, group_count, finished_at, state FROM job_results WHERE result IS NOT NULL",
        )?;
        let rows = st.query_map([], |r| {
            let state: String = r.get(4)?;
            let state: JobState = serde_json::from_str(&state).unwrap_or_default();
            Ok((
                r.get::<_, i64>(0)?,
                JobCounts {
                    old: r.get(1)?,
                    groups: r.get(2)?,
                    finished_at: r.get(3)?,
                    reviewed: state.reviewed.len() as i64,
                },
            ))
        })?;
        rows.collect()
    }

    // ----- Own presets -----

    pub fn user_presets(&self) -> rusqlite::Result<Vec<UserPreset>> {
        let mut st = self
            .conn
            .prepare("SELECT id, name, json FROM presets ORDER BY name COLLATE NOCASE")?;
        let rows = st.query_map([], |r| {
            let json: String = r.get(2)?;
            Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, json))
        })?;
        let mut out = Vec::new();
        for row in rows {
            let (id, name, json) = row?;
            if let Ok(values) = serde_json::from_str::<PresetValues>(&json) {
                out.push(UserPreset {
                    id: format!("u{id}"),
                    name,
                    values,
                });
            }
        }
        Ok(out)
    }

    pub fn save_preset(&self, name: &str, values: &PresetValues) -> rusqlite::Result<String> {
        let json = serde_json::to_string(values).unwrap_or_else(|_| "{}".into());
        self.conn.execute(
            "INSERT INTO presets (name, json) VALUES (?1, ?2)",
            params![name, json],
        )?;
        Ok(format!("u{}", self.conn.last_insert_rowid()))
    }

    fn preset_row(id: &str) -> Option<i64> {
        id.strip_prefix('u').and_then(|n| n.parse().ok())
    }

    pub fn rename_preset(&self, id: &str, name: &str) -> rusqlite::Result<()> {
        if let Some(n) = Db::preset_row(id) {
            self.conn.execute(
                "UPDATE presets SET name = ?2 WHERE id = ?1",
                params![n, name],
            )?;
        }
        Ok(())
    }

    pub fn delete_preset(&self, id: &str) -> rusqlite::Result<()> {
        if let Some(n) = Db::preset_row(id) {
            self.conn
                .execute("DELETE FROM presets WHERE id = ?1", [n])?;
            // Jobs that were set from it no longer have a preset to go back to.
            for mut job in self.jobs()? {
                if job.preset.as_deref() == Some(id) {
                    job.preset = None;
                    self.save_job(&job)?;
                }
            }
        }
        Ok(())
    }

    pub fn setting(&self, key: &str) -> rusqlite::Result<Option<String>> {
        self.conn
            .query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| {
                r.get(0)
            })
            .optional()
    }

    pub fn set_setting(&self, key: &str, value: &str) -> rusqlite::Result<()> {
        self.conn.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2",
            params![key, value],
        )?;
        Ok(())
    }

    pub fn all_settings(&self) -> rusqlite::Result<Vec<(String, String)>> {
        let mut st = self.conn.prepare("SELECT key, value FROM settings")?;
        let rows = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
        rows.collect()
    }

    pub fn add_folder(&self, path: &str) -> rusqlite::Result<()> {
        self.conn.execute(
            "INSERT OR IGNORE INTO folders (path, enabled, added_at) VALUES (?1, 1, ?2)",
            params![path, now()],
        )?;
        Ok(())
    }

    pub fn remove_folder(&self, path: &str) -> rusqlite::Result<()> {
        self.conn
            .execute("DELETE FROM folders WHERE path = ?1", [path])?;
        Ok(())
    }

    pub fn skip_patterns(&self) -> rusqlite::Result<Vec<String>> {
        let mut st = self
            .conn
            .prepare("SELECT pattern FROM skip ORDER BY pattern")?;
        let rows = st.query_map([], |r| r.get(0))?;
        rows.collect()
    }

    pub fn add_skip(&self, pattern: &str) -> rusqlite::Result<()> {
        self.conn.execute(
            "INSERT OR IGNORE INTO skip (pattern) VALUES (?1)",
            [pattern],
        )?;
        Ok(())
    }

    pub fn remove_skip(&self, pattern: &str) -> rusqlite::Result<()> {
        self.conn
            .execute("DELETE FROM skip WHERE pattern = ?1", [pattern])?;
        Ok(())
    }

    pub fn kept(&self) -> rusqlite::Result<Vec<Kept>> {
        let mut st = self
            .conn
            .prepare("SELECT path, at FROM keep ORDER BY at DESC")?;
        let rows = st.query_map([], |r| {
            Ok(Kept {
                path: r.get(0)?,
                at: r.get(1)?,
            })
        })?;
        rows.collect()
    }

    pub fn keep(&mut self, paths: &[String]) -> rusqlite::Result<()> {
        let tx = self.conn.transaction()?;
        let t = now();
        for p in paths {
            tx.execute(
                "INSERT OR IGNORE INTO keep (path, at) VALUES (?1, ?2)",
                params![p, t],
            )?;
        }
        tx.commit()
    }

    pub fn unkeep(&mut self, paths: &[String]) -> rusqlite::Result<()> {
        let tx = self.conn.transaction()?;
        for p in paths {
            tx.execute("DELETE FROM keep WHERE path = ?1", [p])?;
        }
        tx.commit()
    }

    pub fn hash_cache(&self) -> rusqlite::Result<HashCache> {
        let mut st = self
            .conn
            .prepare("SELECT path, size, modified, md5 FROM hashes")?;
        let rows = st.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                Cached {
                    size: r.get::<_, i64>(1)? as u64,
                    modified: r.get(2)?,
                    md5: r.get(3)?,
                },
            ))
        })?;
        rows.collect()
    }

    /// Writes down just the fingerprints a scan worked out, entry by entry, so scans running at
    /// the same time never overwrite each other's.
    pub fn upsert_hashes(&mut self, fresh: &[(String, Cached)]) -> rusqlite::Result<()> {
        let tx = self.conn.transaction()?;
        {
            let mut st = tx.prepare(
                "INSERT INTO hashes (path, size, modified, md5) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(path) DO UPDATE SET size = ?2, modified = ?3, md5 = ?4",
            )?;
            for (path, c) in fresh {
                st.execute(params![path, c.size as i64, c.modified, c.md5])?;
            }
        }
        tx.commit()
    }

    pub fn record_scan(&self, r: &sift_core::model::ScanResult) -> rusqlite::Result<()> {
        self.conn.execute(
            "INSERT INTO scans (started_at, finished_at, folders, files_seen, bytes_seen, old_count, group_count, cancelled) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                r.started_at,
                r.finished_at,
                r.folders.join("\n"),
                r.stats.files_seen as i64,
                r.stats.bytes_seen as i64,
                r.old.len() as i64,
                r.groups.len() as i64,
                r.cancelled as i64
            ],
        )?;
        Ok(())
    }

    pub fn scans(&self) -> rusqlite::Result<Vec<ScanRecord>> {
        let mut st = self.conn.prepare(
            "SELECT id, started_at, finished_at, folders, files_seen, bytes_seen, old_count, group_count, cancelled FROM scans ORDER BY id DESC LIMIT 200",
        )?;
        let rows = st.query_map([], |r| {
            Ok(ScanRecord {
                id: r.get(0)?,
                started_at: r.get(1)?,
                finished_at: r.get(2)?,
                folders: r.get(3)?,
                files_seen: r.get(4)?,
                bytes_seen: r.get(5)?,
                old_count: r.get(6)?,
                group_count: r.get(7)?,
                cancelled: r.get::<_, i64>(8)? != 0,
            })
        })?;
        rows.collect()
    }

    /// Writes one thing Sift did to a file into History.
    pub fn log_action(
        &self,
        kind: &str,
        path: &str,
        to: Option<&str>,
        size: u64,
        reason: &str,
    ) -> rusqlite::Result<()> {
        self.conn.execute(
            "INSERT INTO removals (at, kind, path, dest, size, reason) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![now(), kind, path, to, size as i64, reason],
        )?;
        Ok(())
    }

    pub fn removals(&self) -> rusqlite::Result<Vec<Removal>> {
        let mut st = self.conn.prepare(
            "SELECT id, at, kind, path, dest, size, reason, restored_at FROM removals ORDER BY id DESC LIMIT 5000",
        )?;
        let rows = st.query_map([], |r| {
            Ok(Removal {
                id: r.get(0)?,
                at: r.get(1)?,
                kind: r.get(2)?,
                path: r.get(3)?,
                to: r.get(4)?,
                size: r.get(5)?,
                reason: r.get(6)?,
                restored_at: r.get(7)?,
            })
        })?;
        rows.collect()
    }

    pub fn removal(&self, id: i64) -> rusqlite::Result<Option<Removal>> {
        Ok(self.removals()?.into_iter().find(|r| r.id == id))
    }

    pub fn mark_restored(&self, id: i64) -> rusqlite::Result<()> {
        self.conn.execute(
            "UPDATE removals SET restored_at = ?2 WHERE id = ?1",
            params![id, now()],
        )?;
        Ok(())
    }

    /// The single result Sift kept before jobs existed; only read, to move it into the first job.
    fn load_result(&self) -> rusqlite::Result<Option<String>> {
        self.conn
            .query_row("SELECT json FROM last_result WHERE id = 1", [], |r| {
                r.get(0)
            })
            .optional()
    }
}

/// How many groups count as "duplicates" to review: copies and installer versions.
pub fn main_groups(r: &sift_core::model::ScanResult) -> i64 {
    use sift_core::model::GroupKind;
    r.groups
        .iter()
        .filter(|g| matches!(g.kind, GroupKind::Copies | GroupKind::Versions))
        .count() as i64
}

pub fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("sift-db-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_file(&d);
        d
    }

    /// A database as the version before jobs left it.
    fn legacy(path: &Path) {
        let c = Connection::open(path).unwrap();
        c.execute_batch(SCHEMA).unwrap();
        c.execute_batch(
            "INSERT INTO settings VALUES ('initialised', '1'), ('untouchedMonths', '9'), ('minDupeSize', '10240'), ('dismissed', '[\"copies:c:/a.pdf|c:/b.pdf\"]');
             INSERT INTO folders VALUES ('C:\\Users\\K\\Downloads', 1, 1), ('D:\\Old', 0, 2);",
        )
        .unwrap();
        let result = sift_core::model::ScanResult {
            finished_at: 5,
            ..Default::default()
        };
        c.execute(
            "INSERT INTO last_result (id, json) VALUES (1, ?1)",
            [serde_json::to_string(&result).unwrap()],
        )
        .unwrap();
    }

    #[test]
    fn existing_setup_becomes_the_downloads_job() {
        let p = tmp("migrate");
        legacy(&p);
        let db = Db::open(&p).unwrap();
        let jobs = db.jobs().unwrap();
        assert_eq!(jobs.len(), 1);
        let j = &jobs[0];
        assert_eq!(j.name, "Downloads");
        assert_eq!(j.folders.len(), 2);
        assert!(j.folders[0].active && !j.folders[1].active);
        assert_eq!(j.settings.untouched_months, 9);
        assert_eq!(j.settings.min_size, 10240);
        assert_eq!(j.step, "results");
        assert_eq!(db.setting("activeJob").unwrap().unwrap(), j.id.to_string());
        let (result, state) = db.job_result(j.id).unwrap();
        assert!(result.is_some());
        // The old "not duplicates" mark carries over under the new key.
        assert_eq!(
            state.ignored,
            vec![sift_core::model::group_key(
                sift_core::model::GroupKind::Copies,
                &["c:/a.pdf", "c:/b.pdf"]
            )]
        );
        // Opening again does not make a second job.
        drop(db);
        assert_eq!(Db::open(&p).unwrap().jobs().unwrap().len(), 1);
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn folders_are_one_pool_shared_by_jobs() {
        let p = tmp("pool");
        let db = Db::open(&p).unwrap();
        let first = db.jobs().unwrap().remove(0);
        let second = Job {
            name: "Second".into(),
            folders: first
                .folders
                .iter()
                .map(|f| JobFolder {
                    active: false,
                    ..f.clone()
                })
                .collect(),
            ..Default::default()
        };
        let second_id = db.create_job(&second).unwrap();
        db.add_job_folders(second_id, &["E:\\New".to_string()])
            .unwrap();
        let (a, b) = (
            db.job(first.id).unwrap().unwrap(),
            db.job(second_id).unwrap().unwrap(),
        );
        // Every job lists the new folder; only the job it was added in ticks it.
        assert!(a.folders.iter().any(|f| f.path == "E:\\New" && !f.active));
        assert!(b.folders.iter().any(|f| f.path == "E:\\New" && f.active));
        db.remove_pool_folder("E:\\New").unwrap();
        assert!(!db
            .job(second_id)
            .unwrap()
            .unwrap()
            .folders
            .iter()
            .any(|f| f.path == "E:\\New"));
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn presets_and_results_are_kept_per_job() {
        let p = tmp("presets");
        let db = Db::open(&p).unwrap();
        let id = db.jobs().unwrap()[0].id;
        let values = PresetValues {
            find_old: true,
            find_dupes: false,
            settings: JobSettings::default(),
        };
        let pid = db.save_preset("Mine", &values).unwrap();
        assert_eq!(db.user_presets().unwrap()[0].id, pid);
        db.rename_preset(&pid, "Renamed").unwrap();
        assert_eq!(db.user_presets().unwrap()[0].name, "Renamed");
        db.save_job_state(id, "{\"selOld\":[\"x\"]}").unwrap();
        assert_eq!(db.job_result(id).unwrap().1.sel_old, vec!["x".to_string()]);
        db.save_job_result(id, "{}", "{}", 3, 2, 9).unwrap();
        assert_eq!(db.job_counts().unwrap()[&id].old, 3);
        db.delete_preset(&pid).unwrap();
        assert!(db.user_presets().unwrap().is_empty());
        let mut fresh = Vec::new();
        fresh.push((
            "c:/a".to_string(),
            Cached {
                size: 1,
                modified: 2,
                md5: "x".into(),
            },
        ));
        let mut db = db;
        db.upsert_hashes(&fresh).unwrap();
        fresh[0].1.md5 = "y".into();
        db.upsert_hashes(&fresh).unwrap();
        assert_eq!(db.hash_cache().unwrap()["c:/a"].md5, "y");
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn history_keeps_the_kind_and_where_a_file_went() {
        let p = tmp("history");
        let db = Db::open(&p).unwrap();
        db.log_action("recycled", "C:\\a.pdf", None, 10, "Copy")
            .unwrap();
        db.log_action("moved", "C:\\b.pdf", Some("E:\\b.pdf"), 20, "Copy")
            .unwrap();
        db.log_action("deleted", "C:\\c.pdf", None, 30, "Copy")
            .unwrap();
        let all = db.removals().unwrap();
        assert_eq!(all[0].kind, "deleted");
        assert_eq!(all[1].to.as_deref(), Some("E:\\b.pdf"));
        assert_eq!(all[2].kind, "recycled");
        // Opening a database from before kinds existed turns its rows into "recycled".
        drop(db);
        let old = tmp("history-old");
        {
            let c = Connection::open(&old).unwrap();
            c.execute_batch(
                "CREATE TABLE removals (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, path TEXT NOT NULL, size INTEGER NOT NULL, reason TEXT NOT NULL, restored_at INTEGER);
                 INSERT INTO removals (at, path, size, reason) VALUES (1, 'C:\\x', 5, 'old');",
            )
            .unwrap();
        }
        let db = Db::open(&old).unwrap();
        assert_eq!(db.removals().unwrap()[0].kind, "recycled");
        let _ = std::fs::remove_file(&p);
        let _ = std::fs::remove_file(&old);
    }
}
