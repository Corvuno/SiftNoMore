// No console window next to the app on Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! The Sift window and what it can ask for. Everything runs only while the window is open and
//! only when the user presses something: no background process, no autorun, no timers.

mod db;
mod installed;

use db::Db;
use serde::{Deserialize, Serialize};
use sift_core::model::ScanResult;
use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Instant;
use tauri::{Emitter, Manager, State};

struct App {
    db: Mutex<Db>,
    cancel: AtomicBool,
    scanning: AtomicBool,
    last: Mutex<Option<ScanResult>>,
}

type Res<T> = Result<T, String>;

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Overview {
    folders: Vec<db::Folder>,
    skip: Vec<String>,
    kept: Vec<db::Kept>,
    settings: std::collections::HashMap<String, String>,
    scans: Vec<db::ScanRecord>,
    removals: Vec<db::Removal>,
    can_put_back: bool,
}

#[tauri::command]
fn overview(app: State<App>) -> Res<Overview> {
    let db = app.db.lock().unwrap();
    Ok(Overview {
        folders: db.folders().map_err(err)?,
        skip: db.skip_patterns().map_err(err)?,
        kept: db.kept().map_err(err)?,
        settings: db.all_settings().map_err(err)?.into_iter().collect(),
        scans: db.scans().map_err(err)?,
        removals: db.removals().map_err(err)?,
        can_put_back: cfg!(windows),
    })
}

/// The results of the last scan, as JSON text (it can be large; the window parses it once).
#[tauri::command]
fn last_result(app: State<App>) -> Res<Option<String>> {
    let last = app.last.lock().unwrap();
    match &*last {
        Some(r) => Ok(Some(serde_json::to_string(r).map_err(err)?)),
        None => Ok(None),
    }
}

#[tauri::command]
async fn pick_folder(handle: tauri::AppHandle) -> Res<Option<String>> {
    use tauri_plugin_dialog::DialogExt;
    let picked =
        tauri::async_runtime::spawn_blocking(move || handle.dialog().file().blocking_pick_folder())
            .await
            .map_err(err)?;
    Ok(picked
        .and_then(|p| p.into_path().ok())
        .map(|p| p.to_string_lossy().to_string()))
}

#[tauri::command]
fn add_folder(app: State<App>, path: String) -> Res<()> {
    app.db.lock().unwrap().add_folder(&path).map_err(err)
}

#[tauri::command]
fn set_folder_enabled(app: State<App>, path: String, enabled: bool) -> Res<()> {
    app.db
        .lock()
        .unwrap()
        .set_folder_enabled(&path, enabled)
        .map_err(err)
}

#[tauri::command]
fn remove_folder(app: State<App>, path: String) -> Res<()> {
    app.db.lock().unwrap().remove_folder(&path).map_err(err)
}

#[tauri::command]
fn add_skip(app: State<App>, pattern: String) -> Res<()> {
    app.db.lock().unwrap().add_skip(pattern.trim()).map_err(err)
}

#[tauri::command]
fn remove_skip(app: State<App>, pattern: String) -> Res<()> {
    app.db.lock().unwrap().remove_skip(&pattern).map_err(err)
}

#[tauri::command]
fn set_setting(app: State<App>, key: String, value: String) -> Res<()> {
    app.db
        .lock()
        .unwrap()
        .set_setting(&key, &value)
        .map_err(err)
}

fn save_last(app: &App) {
    let last = app.last.lock().unwrap();
    if let Some(r) = &*last {
        if let Ok(json) = serde_json::to_string(r) {
            let _ = app.db.lock().unwrap().save_result(&json);
        }
    }
}

/// Puts files on the keep-list: they never show as old again and are never picked for removal.
#[tauri::command]
fn keep(app: State<App>, paths: Vec<String>) -> Res<()> {
    app.db.lock().unwrap().keep(&paths).map_err(err)?;
    let set: HashSet<String> = paths.iter().map(|p| p.to_lowercase()).collect();
    if let Some(r) = app.last.lock().unwrap().as_mut() {
        let mut ids = HashSet::new();
        for f in r.files.iter_mut() {
            if set.contains(&f.path.to_lowercase()) {
                f.kept = true;
                ids.insert(f.id);
            }
        }
        r.old.retain(|o| !ids.contains(&o.file));
    }
    save_last(&app);
    Ok(())
}

#[tauri::command]
fn unkeep(app: State<App>, paths: Vec<String>) -> Res<()> {
    app.db.lock().unwrap().unkeep(&paths).map_err(err)?;
    let set: HashSet<String> = paths.iter().map(|p| p.to_lowercase()).collect();
    if let Some(r) = app.last.lock().unwrap().as_mut() {
        for f in r.files.iter_mut() {
            if set.contains(&f.path.to_lowercase()) {
                f.kept = false;
            }
        }
    }
    save_last(&app);
    Ok(())
}

fn setting_u64(db: &Db, key: &str, default: u64) -> u64 {
    db.setting(key)
        .ok()
        .flatten()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

#[tauri::command]
async fn scan(handle: tauri::AppHandle) -> Res<String> {
    let app = handle.state::<App>();
    if app.scanning.swap(true, Ordering::SeqCst) {
        return Err("A scan is already running.".into());
    }
    app.cancel.store(false, Ordering::SeqCst);
    let h2 = handle.clone();
    let out = tauri::async_runtime::spawn_blocking(move || -> Res<String> {
        let app = h2.state::<App>();
        let (req, mut cache) = {
            let db = app.db.lock().unwrap();
            let folders: Vec<String> = db
                .folders()
                .map_err(err)?
                .into_iter()
                .filter(|f| f.enabled)
                .map(|f| f.path)
                .collect();
            if folders.is_empty() {
                return Err(
                    "There are no folders to look in yet. Add one under Where to look.".into(),
                );
            }
            let req = sift_core::ScanRequest {
                folders,
                skip: db.skip_patterns().map_err(err)?,
                keep: db
                    .kept()
                    .map_err(err)?
                    .into_iter()
                    .map(|k| k.path)
                    .collect(),
                installed: installed::program_names(),
                old: sift_core::old::OldSettings {
                    untouched_months: setting_u64(&db, "untouchedMonths", 6) as u32,
                    archive_months: setting_u64(&db, "archiveMonths", 3) as u32,
                },
                dupes: sift_core::dupes::DupeSettings {
                    min_size: setting_u64(&db, "minDupeSize", 1024),
                    similar: setting_u64(&db, "similarNames", 90) as u32,
                },
                now: db::now(),
            };
            (req, db.hash_cache().map_err(err)?)
        };
        let last_emit = Mutex::new(Instant::now());
        let emitter = h2.clone();
        let progress = move |p: sift_core::Progress| {
            let mut t = last_emit.lock().unwrap();
            let always = matches!(p, sift_core::Progress::Checking);
            if always || t.elapsed().as_millis() >= 100 {
                *t = Instant::now();
                let _ = emitter.emit("scan-progress", &p);
            }
        };
        let mut result = sift_core::run(&req, &mut cache, &app.cancel, &progress);
        result.finished_at = db::now();
        let json = serde_json::to_string(&result).map_err(err)?;
        {
            let mut db = app.db.lock().unwrap();
            let _ = db.save_hash_cache(&cache);
            let _ = db.record_scan(&result);
            if !result.cancelled {
                let _ = db.save_result(&json);
            }
        }
        if !result.cancelled {
            *app.last.lock().unwrap() = Some(result);
        }
        Ok(json)
    })
    .await
    .map_err(err);
    app.scanning.store(false, Ordering::SeqCst);
    out?
}

#[tauri::command]
fn cancel_scan(app: State<App>) {
    app.cancel.store(true, Ordering::SeqCst);
}

#[derive(Deserialize)]
struct ToRecycle {
    path: String,
    reason: String,
}

#[derive(Serialize)]
struct Failed {
    path: String,
    error: String,
}

#[derive(Serialize)]
struct RecycleOutcome {
    moved: Vec<String>,
    failed: Vec<Failed>,
}

/// Moves files to the Recycle Bin, one by one, and logs each one. Nothing is ever deleted
/// outright: if the Recycle Bin can't take a file, it stays where it is and is reported.
#[tauri::command]
async fn recycle(handle: tauri::AppHandle, items: Vec<ToRecycle>) -> Res<RecycleOutcome> {
    let h2 = handle.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let app = h2.state::<App>();
        let mut moved = Vec::new();
        let mut failed = Vec::new();
        for it in items {
            let meta = match std::fs::metadata(&it.path) {
                Ok(m) if m.is_file() => m,
                Ok(_) => {
                    failed.push(Failed {
                        path: it.path,
                        error: "Not a file.".into(),
                    });
                    continue;
                }
                Err(_) => {
                    failed.push(Failed {
                        path: it.path,
                        error: "It is no longer there.".into(),
                    });
                    continue;
                }
            };
            // A file that changed since the scan is left alone: what Sift said about it may no
            // longer be true.
            let changed = app.last.lock().unwrap().as_ref().and_then(|r| {
                let want = it.path.to_lowercase();
                r.files
                    .iter()
                    .find(|f| f.path.to_lowercase() == want)
                    .map(|f| {
                        let modified = meta
                            .modified()
                            .ok()
                            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                            .map(|d| d.as_secs() as i64)
                            .unwrap_or(0);
                        f.size != meta.len() || f.modified != modified
                    })
            });
            if changed == Some(true) {
                failed.push(Failed {
                    path: it.path,
                    error: "It changed since the scan. Scan again first.".into(),
                });
                continue;
            }
            match trash::delete(&it.path) {
                Ok(()) => {
                    let logged =
                        app.db
                            .lock()
                            .unwrap()
                            .log_removal(&it.path, meta.len(), &it.reason);
                    if let Err(e) = logged {
                        failed.push(Failed {
                            path: it.path.clone(),
                            error: format!(
                                "Moved to the Recycle Bin, but not written in History: {e}"
                            ),
                        });
                    }
                    moved.push(it.path);
                }
                Err(e) => failed.push(Failed {
                    path: it.path,
                    error: e.to_string(),
                }),
            }
        }
        // Take what went out of the remembered results too.
        let gone: HashSet<String> = moved.iter().map(|p| p.to_lowercase()).collect();
        if let Some(r) = app.last.lock().unwrap().as_mut() {
            let ids: HashSet<u32> = r
                .files
                .iter()
                .filter(|f| gone.contains(&f.path.to_lowercase()))
                .map(|f| f.id)
                .collect();
            r.files.retain(|f| !ids.contains(&f.id));
            r.old.retain(|o| !ids.contains(&o.file));
            for g in r.groups.iter_mut() {
                g.files.retain(|i| !ids.contains(i));
                if ids.contains(&g.suggested) {
                    if let Some(&first) = g.files.first() {
                        g.suggested = first;
                    }
                }
            }
            r.groups.retain(|g| g.files.len() >= 2);
        }
        save_last(&app);
        Ok(RecycleOutcome { moved, failed })
    })
    .await
    .map_err(err)?
}

/// Takes a file back out of the Recycle Bin, to where it was.
#[tauri::command]
fn put_back(app: State<App>, id: i64) -> Res<()> {
    let removal = app
        .db
        .lock()
        .unwrap()
        .removal(id)
        .map_err(err)?
        .ok_or("Not in the log.")?;
    restore_from_bin(&removal.path)?;
    app.db.lock().unwrap().mark_restored(id).map_err(err)
}

#[cfg(windows)]
fn restore_from_bin(path: &str) -> Res<()> {
    use trash::os_limited;
    if std::path::Path::new(path).exists() {
        return Err("A file with that name is already back in its place.".into());
    }
    let items = os_limited::list().map_err(err)?;
    let want = path.to_lowercase();
    let item = items
        .into_iter()
        .filter(|i| i.original_path().to_string_lossy().to_lowercase() == want)
        .max_by_key(|i| i.time_deleted)
        .ok_or("It is no longer in the Recycle Bin.")?;
    os_limited::restore_all([item]).map_err(err)
}

#[cfg(not(windows))]
fn restore_from_bin(_path: &str) -> Res<()> {
    Err("Putting back works on Windows only.".into())
}

#[tauri::command]
fn show_in_folder(path: String) -> Res<()> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("explorer")
            .raw_arg(format!("/select,\"{}\"", path))
            .spawn()
            .map_err(err)?;
    }
    #[cfg(not(windows))]
    {
        let dir = std::path::Path::new(&path)
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_default();
        std::process::Command::new("xdg-open")
            .arg(dir)
            .spawn()
            .map_err(err)?;
    }
    Ok(())
}

#[tauri::command]
fn open_file(path: String) -> Res<()> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("explorer")
            .raw_arg(format!("\"{}\"", path))
            .spawn()
            .map_err(err)?;
    }
    #[cfg(not(windows))]
    {
        std::process::Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(err)?;
    }
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            let db = Db::open(&dir.join("sift.db"))?;
            let last = db
                .load_result()
                .ok()
                .flatten()
                .and_then(|j| serde_json::from_str::<ScanResult>(&j).ok());
            app.manage(App {
                db: Mutex::new(db),
                cancel: AtomicBool::new(false),
                scanning: AtomicBool::new(false),
                last: Mutex::new(last),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            overview,
            last_result,
            pick_folder,
            add_folder,
            set_folder_enabled,
            remove_folder,
            add_skip,
            remove_skip,
            set_setting,
            keep,
            unkeep,
            scan,
            cancel_scan,
            recycle,
            put_back,
            show_in_folder,
            open_file
        ])
        .run(tauri::generate_context!())
        .expect("Sift could not start");
}
