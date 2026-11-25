//! What Sift remembers between runs, in one SQLite file in the user's app-data folder: settings,
//! folders to look in, skip patterns, the keep-list, content fingerprints, the scan history, the
//! log of what went to the Recycle Bin, and the last results.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sift_core::dupes::{Cached, HashCache};
use std::path::Path;

pub struct Db {
    conn: Connection,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Folder {
    pub path: String,
    pub enabled: bool,
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
    pub path: String,
    pub size: i64,
    pub reason: String,
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
        Ok(db)
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

    pub fn folders(&self) -> rusqlite::Result<Vec<Folder>> {
        let mut st = self
            .conn
            .prepare("SELECT path, enabled FROM folders ORDER BY added_at")?;
        let rows = st.query_map([], |r| {
            Ok(Folder {
                path: r.get(0)?,
                enabled: r.get::<_, i64>(1)? != 0,
            })
        })?;
        rows.collect()
    }

    pub fn add_folder(&self, path: &str) -> rusqlite::Result<()> {
        self.conn.execute(
            "INSERT OR IGNORE INTO folders (path, enabled, added_at) VALUES (?1, 1, ?2)",
            params![path, now()],
        )?;
        Ok(())
    }

    pub fn set_folder_enabled(&self, path: &str, enabled: bool) -> rusqlite::Result<()> {
        self.conn.execute(
            "UPDATE folders SET enabled = ?2 WHERE path = ?1",
            params![path, enabled as i64],
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

    pub fn save_hash_cache(&mut self, cache: &HashCache) -> rusqlite::Result<()> {
        let tx = self.conn.transaction()?;
        tx.execute("DELETE FROM hashes", [])?;
        {
            let mut st = tx.prepare(
                "INSERT OR REPLACE INTO hashes (path, size, modified, md5) VALUES (?1, ?2, ?3, ?4)",
            )?;
            for (path, c) in cache {
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

    pub fn log_removal(&self, path: &str, size: u64, reason: &str) -> rusqlite::Result<()> {
        self.conn.execute(
            "INSERT INTO removals (at, path, size, reason) VALUES (?1, ?2, ?3, ?4)",
            params![now(), path, size as i64, reason],
        )?;
        Ok(())
    }

    pub fn removals(&self) -> rusqlite::Result<Vec<Removal>> {
        let mut st = self.conn.prepare(
            "SELECT id, at, path, size, reason, restored_at FROM removals ORDER BY id DESC LIMIT 5000",
        )?;
        let rows = st.query_map([], |r| {
            Ok(Removal {
                id: r.get(0)?,
                at: r.get(1)?,
                path: r.get(2)?,
                size: r.get(3)?,
                reason: r.get(4)?,
                restored_at: r.get(5)?,
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

    pub fn save_result(&self, json: &str) -> rusqlite::Result<()> {
        self.conn.execute(
            "INSERT INTO last_result (id, json) VALUES (1, ?1) ON CONFLICT(id) DO UPDATE SET json = ?1",
            [json],
        )?;
        Ok(())
    }

    pub fn load_result(&self) -> rusqlite::Result<Option<String>> {
        self.conn
            .query_row("SELECT json FROM last_result WHERE id = 1", [], |r| {
                r.get(0)
            })
            .optional()
    }
}

pub fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}
