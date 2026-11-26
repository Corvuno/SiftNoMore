// No console window next to the app on Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! The Sift window and what it can ask for. Everything runs only while the window is open and
//! only when the user presses something: no background process, no autorun, no timers.

mod db;
mod installed;

use db::{Db, Job, JobCounts, JobFolder, JobState, UserPreset};
use serde::Serialize;
use sift_core::model::ScanResult;
use sift_core::presets::{Preset, PresetValues};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tauri::{Emitter, Manager, State};

/// At most this many scans run at the same time. Nothing queues: a fourth is refused.
const MAX_SCANS: usize = 3;

struct App {
    db: Mutex<Db>,
    /// The jobs that are scanning now, each with its own stop flag.
    running: Mutex<HashMap<i64, Arc<AtomicBool>>>,
    /// The results of jobs opened or scanned in this run, kept in memory.
    results: Mutex<HashMap<i64, ScanResult>>,
}

type Res<T> = Result<T, String>;

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Overview {
    jobs: Vec<Job>,
    counts: HashMap<i64, JobCounts>,
    presets: Vec<Preset>,
    user_presets: Vec<UserPreset>,
    skip: Vec<String>,
    kept: Vec<db::Kept>,
    settings: HashMap<String, String>,
    scans: Vec<db::ScanRecord>,
    removals: Vec<db::Removal>,
    can_put_back: bool,
}

#[tauri::command]
fn overview(app: State<App>) -> Res<Overview> {
    let db = app.db.lock().unwrap();
    Ok(Overview {
        jobs: db.jobs().map_err(err)?,
        counts: db.job_counts().map_err(err)?,
        presets: sift_core::presets::builtin(),
        user_presets: db.user_presets().map_err(err)?,
        skip: db.skip_patterns().map_err(err)?,
        kept: db.kept().map_err(err)?,
        settings: db.all_settings().map_err(err)?.into_iter().collect(),
        scans: db.scans().map_err(err)?,
        removals: db.removals().map_err(err)?,
        can_put_back: cfg!(windows),
    })
}

// ----- Jobs -----

#[tauri::command]
fn job_create(app: State<App>) -> Res<Job> {
    let db = app.db.lock().unwrap();
    let jobs = db.jobs().map_err(err)?;
    let names: HashSet<String> = jobs.iter().map(|j| j.name.to_lowercase()).collect();
    let n = (1..)
        .find(|n| !names.contains(&format!("job {n}")))
        .unwrap();
    let quick = sift_core::presets::builtin().remove(0);
    let mut job = Job {
        name: format!("Job {n}"),
        folders: db
            .pool()
            .map_err(err)?
            .into_iter()
            .map(|path| JobFolder {
                path,
                active: false,
                recursive: true,
            })
            .collect(),
        find_old: quick.values.find_old,
        find_dupes: quick.values.find_dupes,
        preset: Some(quick.id),
        settings: quick.values.settings,
        ..Default::default()
    };
    job.id = db.create_job(&job).map_err(err)?;
    Ok(job)
}

#[tauri::command]
fn job_duplicate(app: State<App>, id: i64) -> Res<Job> {
    let db = app.db.lock().unwrap();
    let mut job = db.job(id).map_err(err)?.ok_or("That job is gone.")?;
    job.name = format!("{} copy", job.name);
    job.step = "setup".into();
    job.id = db.create_job(&job).map_err(err)?;
    Ok(job)
}

#[tauri::command]
fn job_save(app: State<App>, job: Job) -> Res<()> {
    if !job.find_old && !job.find_dupes {
        return Err("A job has to look for at least one thing.".into());
    }
    app.db.lock().unwrap().save_job(&job).map_err(err)
}

#[tauri::command]
fn job_delete(app: State<App>, id: i64) -> Res<()> {
    if let Some(flag) = app.running.lock().unwrap().get(&id) {
        flag.store(true, Ordering::SeqCst);
    }
    app.results.lock().unwrap().remove(&id);
    app.db.lock().unwrap().delete_job(id).map_err(err)
}

/// What the window gets when it opens a job: the saved result (as JSON text; it can be large),
/// what was selected and reviewed, and how many files had to be dropped because they are gone.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Opened {
    result: Option<ScanResult>,
    state: JobState,
    dropped: usize,
}

fn order_of(job: &Job) -> Vec<String> {
    job.active_folders()
        .iter()
        .map(|f| f.path.clone())
        .collect()
}

fn mark_kept(db: &Db, r: &mut ScanResult) {
    let keep: HashSet<String> = db
        .kept()
        .unwrap_or_default()
        .into_iter()
        .map(|k| sift_core::scan::norm_path(&k.path))
        .collect();
    let mut ids = HashSet::new();
    for f in r.files.iter_mut() {
        f.kept = keep.contains(&sift_core::scan::norm_path(&f.path));
        if f.kept {
            ids.insert(f.id);
        }
    }
    r.old.retain(|o| !ids.contains(&o.file));
}

fn save_result(db: &Db, job_id: i64, r: &ScanResult, state: &JobState) {
    if let (Ok(json), Ok(st)) = (serde_json::to_string(r), serde_json::to_string(state)) {
        let _ = db.save_job_result(
            job_id,
            &json,
            &st,
            r.old.len() as i64,
            db::main_groups(r),
            r.finished_at,
        );
    }
}

/// Keeps only the selected and reviewed marks that still point at something in the result.
fn prune_state(state: &mut JobState, r: &ScanResult) {
    let paths: HashSet<String> = r
        .files
        .iter()
        .map(|f| sift_core::scan::norm_path(&f.path))
        .collect();
    let keys: HashSet<&str> = r.groups.iter().map(|g| g.key.as_str()).collect();
    let live = |p: &String| paths.contains(&sift_core::scan::norm_path(p));
    state.sel_old.retain(live);
    state.sel_dupes.retain(live);
    state.reviewed.retain(|k| keys.contains(k.as_str()));
    state.ignored.retain(|k| keys.contains(k.as_str()));
}

/// Opens a job's saved result: the files are looked at on disk and what is gone or changed is
/// dropped from it.
#[tauri::command]
async fn job_open(handle: tauri::AppHandle, id: i64) -> Res<String> {
    tauri::async_runtime::spawn_blocking(move || -> Res<String> {
        let app = handle.state::<App>();
        let (job, (json, mut state)) = {
            let db = app.db.lock().unwrap();
            let job = db.job(id).map_err(err)?.ok_or("That job is gone.")?;
            (job, db.job_result(id).map_err(err)?)
        };
        let mut dropped = 0;
        let mut result = match json {
            Some(j) => serde_json::from_str::<ScanResult>(&j).ok(),
            None => None,
        };
        if let Some(r) = result.as_mut() {
            r.fill_keys();
            dropped = sift_core::recheck(r);
            let db = app.db.lock().unwrap();
            mark_kept(&db, r);
            sift_core::keep::apply_folder_picks(r, &order_of(&job));
            prune_state(&mut state, r);
            if dropped > 0 {
                save_result(&db, id, r, &state);
            }
        }
        match &result {
            Some(r) => app.results.lock().unwrap().insert(id, r.clone()),
            None => app.results.lock().unwrap().remove(&id),
        };
        serde_json::to_string(&Opened {
            result,
            state,
            dropped,
        })
        .map_err(err)
    })
    .await
    .map_err(err)?
}

#[tauri::command]
fn job_state_save(app: State<App>, id: i64, state: JobState) -> Res<()> {
    let json = serde_json::to_string(&state).map_err(err)?;
    app.db
        .lock()
        .unwrap()
        .save_job_state(id, &json)
        .map_err(err)
}

/// After the folder order changed: which file each group keeps by folder order.
#[tauri::command]
fn job_picks(app: State<App>, id: i64) -> Res<Vec<Option<u32>>> {
    let job = app
        .db
        .lock()
        .unwrap()
        .job(id)
        .map_err(err)?
        .ok_or("That job is gone.")?;
    let results = app.results.lock().unwrap();
    Ok(results
        .get(&id)
        .map(|r| sift_core::keep::folder_picks(r, &order_of(&job)))
        .unwrap_or_default())
}

// ----- Presets -----

#[tauri::command]
fn preset_save(app: State<App>, name: String, values: PresetValues) -> Res<String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("A preset needs a name.".into());
    }
    app.db
        .lock()
        .unwrap()
        .save_preset(name, &values)
        .map_err(err)
}

#[tauri::command]
fn preset_rename(app: State<App>, id: String, name: String) -> Res<()> {
    let name = name.trim();
    if name.is_empty() {
        return Err("A preset needs a name.".into());
    }
    app.db.lock().unwrap().rename_preset(&id, name).map_err(err)
}

#[tauri::command]
fn preset_delete(app: State<App>, id: String) -> Res<()> {
    app.db.lock().unwrap().delete_preset(&id).map_err(err)
}

// ----- Folders -----

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

/// Adds folders to the pool and ticks them in this job.
#[tauri::command]
fn add_folders(app: State<App>, job_id: i64, paths: Vec<String>) -> Res<()> {
    let paths: Vec<String> = paths
        .into_iter()
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
        .collect();
    app.db
        .lock()
        .unwrap()
        .add_job_folders(job_id, &paths)
        .map_err(err)
}

/// Removes a folder from the pool, so from every job.
#[tauri::command]
fn remove_folder(app: State<App>, path: String) -> Res<()> {
    app.db
        .lock()
        .unwrap()
        .remove_pool_folder(&path)
        .map_err(err)
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

/// Writes every result held in memory back (after a change that touches many jobs).
fn save_cached(app: &App) {
    let results = app.results.lock().unwrap();
    let db = app.db.lock().unwrap();
    for (&id, r) in results.iter() {
        let state = db.job_result(id).map(|(_, s)| s).unwrap_or_default();
        save_result(&db, id, r, &state);
    }
}

/// Puts files on the keep-list: they never show as old again and are never picked for removal.
#[tauri::command]
fn keep(app: State<App>, paths: Vec<String>) -> Res<()> {
    app.db.lock().unwrap().keep(&paths).map_err(err)?;
    let set: HashSet<String> = paths.iter().map(|p| p.to_lowercase()).collect();
    for r in app.results.lock().unwrap().values_mut() {
        let mut ids = HashSet::new();
        for f in r.files.iter_mut() {
            if set.contains(&f.path.to_lowercase()) {
                f.kept = true;
                ids.insert(f.id);
            }
        }
        r.old.retain(|o| !ids.contains(&o.file));
    }
    save_cached(&app);
    Ok(())
}

#[tauri::command]
fn unkeep(app: State<App>, paths: Vec<String>) -> Res<()> {
    app.db.lock().unwrap().unkeep(&paths).map_err(err)?;
    let set: HashSet<String> = paths.iter().map(|p| p.to_lowercase()).collect();
    for r in app.results.lock().unwrap().values_mut() {
        for f in r.files.iter_mut() {
            if set.contains(&f.path.to_lowercase()) {
                f.kept = false;
            }
        }
    }
    save_cached(&app);
    Ok(())
}

/// Starts a scan of one job. Up to three jobs scan at once; nothing is queued.
#[tauri::command]
async fn scan(handle: tauri::AppHandle, job_id: i64) -> Res<String> {
    let app = handle.state::<App>();
    let cancel = {
        let mut running = app.running.lock().unwrap();
        if running.contains_key(&job_id) {
            return Err("This job is already scanning.".into());
        }
        if running.len() >= MAX_SCANS {
            return Err("Three scans are running; wait or stop one.".into());
        }
        let flag = Arc::new(AtomicBool::new(false));
        running.insert(job_id, flag.clone());
        flag
    };
    let h2 = handle.clone();
    let out = tauri::async_runtime::spawn_blocking(move || -> Res<String> {
        let app = h2.state::<App>();
        let (job, req, mut cache) = {
            let db = app.db.lock().unwrap();
            let job = db.job(job_id).map_err(err)?.ok_or("That job is gone.")?;
            let folders: Vec<sift_core::scan::ScanFolder> = job
                .active_folders()
                .into_iter()
                .map(|f| sift_core::scan::ScanFolder {
                    path: f.path.clone(),
                    recursive: f.recursive,
                })
                .collect();
            if folders.is_empty() {
                return Err("Tick at least one folder to look in first.".into());
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
                find_old: job.find_old,
                find_dupes: job.find_dupes,
                settings: job.settings.clone(),
                now: db::now(),
            };
            (job, req, db.hash_cache().map_err(err)?)
        };
        let last_emit = Mutex::new(Instant::now());
        let emitter = h2.clone();
        let progress = move |p: sift_core::Progress| {
            let mut t = last_emit.lock().unwrap();
            let always = matches!(p, sift_core::Progress::Checking);
            if always || t.elapsed().as_millis() >= 100 {
                *t = Instant::now();
                if let Ok(mut v) = serde_json::to_value(&p) {
                    v["jobId"] = job_id.into();
                    let _ = emitter.emit("scan-progress", v);
                }
            }
        };
        let fresh = Mutex::new(Vec::new());
        let mut result = sift_core::run(&req, &mut cache, &cancel, &progress, Some(&fresh));
        result.finished_at = db::now();
        let mut db = app.db.lock().unwrap();
        let _ = db.upsert_hashes(&fresh.into_inner().unwrap());
        let _ = db.record_scan(&result);
        if result.cancelled {
            return serde_json::to_string(&Opened {
                result: None,
                state: JobState::default(),
                dropped: 0,
            })
            .map_err(err);
        }
        // What was selected and reviewed stays for the files and groups that are still there.
        let mut state = db.job_result(job_id).map(|(_, s)| s).unwrap_or_default();
        prune_state(&mut state, &result);
        sift_core::keep::apply_folder_picks(&mut result, &order_of(&job));
        save_result(&db, job_id, &result, &state);
        drop(db);
        app.results.lock().unwrap().insert(job_id, result.clone());
        serde_json::to_string(&Opened {
            result: Some(result),
            state,
            dropped: 0,
        })
        .map_err(err)
    })
    .await
    .map_err(err);
    app.running.lock().unwrap().remove(&job_id);
    out?
}

#[tauri::command]
fn cancel_scan(app: State<App>, job_id: i64) {
    if let Some(flag) = app.running.lock().unwrap().get(&job_id) {
        flag.store(true, Ordering::SeqCst);
    }
}

// ----- Act -----

/// The plan for what the window has chosen on the Act step, made from the job's saved result.
fn make_plan(
    app: &App,
    job_id: i64,
    mut req: sift_core::plan::ActRequest,
) -> Res<sift_core::plan::Plan> {
    let job = app
        .db
        .lock()
        .unwrap()
        .job(job_id)
        .map_err(err)?
        .ok_or("That job is gone.")?;
    req.folder_order = order_of(&job);
    req.roots = req.folder_order.clone();
    let results = app.results.lock().unwrap();
    let result = results.get(&job_id).ok_or("Scan or open this job first.")?;
    Ok(sift_core::plan::build(result, &req, &|p| {
        std::path::Path::new(p).exists()
    }))
}

/// What Go would do, without doing any of it: the dry run.
#[tauri::command]
async fn plan_act(
    handle: tauri::AppHandle,
    job_id: i64,
    req: sift_core::plan::ActRequest,
) -> Res<sift_core::plan::Plan> {
    tauri::async_runtime::spawn_blocking(move || make_plan(&handle.state::<App>(), job_id, req))
        .await
        .map_err(err)?
}

#[derive(Serialize)]
struct Failed {
    path: String,
    error: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ActOutcome {
    recycled: usize,
    moved: usize,
    renamed: usize,
    deleted: usize,
    failed: Vec<Failed>,
}

/// Moves a file: a rename, or when that is not possible (another drive) a copy, after which the
/// original goes to the Recycle Bin. Never overwrites.
fn move_file(from: &str, to: &str) -> Res<()> {
    if std::path::Path::new(to).exists() {
        return Err("A file with that name is already there.".into());
    }
    if let Some(dir) = std::path::Path::new(to).parent() {
        std::fs::create_dir_all(dir).map_err(err)?;
    }
    if std::fs::rename(from, to).is_ok() {
        return Ok(());
    }
    std::fs::copy(from, to).map_err(err)?;
    if let Err(e) = trash::delete(from) {
        // Leave one copy: the one just made goes to the Recycle Bin again.
        let _ = trash::delete(to);
        return Err(format!("Could not move it off the original place: {e}"));
    }
    Ok(())
}

fn exists(p: &str) -> bool {
    std::path::Path::new(p).exists()
}

/// Does what the plan says, in its order, one file at a time, and writes each step in History.
/// A file that changed since the scan is left alone. Permanent deletes only run when the window
/// says the second question was answered.
#[tauri::command]
async fn act(
    handle: tauri::AppHandle,
    job_id: i64,
    req: sift_core::plan::ActRequest,
    confirmed_delete: bool,
) -> Res<ActOutcome> {
    use sift_core::plan::{OpKind, Removal};
    tauri::async_runtime::spawn_blocking(move || {
        let app = handle.state::<App>();
        if req.removal == Removal::Delete && !confirmed_delete {
            return Err("Deleting for good has to be confirmed first.".to_string());
        }
        let plan = make_plan(&app, job_id, req)?;
        // What the scan saw of each file, to notice changes.
        let seen: HashMap<u32, (String, u64, i64)> = app
            .results
            .lock()
            .unwrap()
            .get(&job_id)
            .map(|r| {
                r.files
                    .iter()
                    .map(|f| (f.id, (f.path.clone(), f.size, f.modified)))
                    .collect()
            })
            .unwrap_or_default();
        let mut out = ActOutcome {
            recycled: 0,
            moved: 0,
            renamed: 0,
            deleted: 0,
            failed: Vec::new(),
        };
        let mut touched: HashSet<u32> = HashSet::new();
        let mut broken: HashSet<u32> = HashSet::new();
        let mut changed: HashSet<u32> = HashSet::new();
        for op in &plan.ops {
            if broken.contains(&op.id) {
                continue;
            }
            let first = touched.insert(op.id);
            let fail = |out: &mut ActOutcome, broken: &mut HashSet<u32>, error: String| {
                broken.insert(op.id);
                out.failed.push(Failed {
                    path: op.from.clone(),
                    error,
                });
            };
            let meta = match std::fs::metadata(&op.from) {
                Ok(m) if m.is_file() => m,
                Ok(_) => {
                    fail(&mut out, &mut broken, "Not a file.".into());
                    continue;
                }
                Err(_) => {
                    fail(&mut out, &mut broken, "It is no longer there.".into());
                    continue;
                }
            };
            if first {
                // A file that changed since the scan is left alone: what Sift said about it may
                // no longer be true.
                if let Some((_, size, modified)) = seen.get(&op.id) {
                    let now = meta
                        .modified()
                        .ok()
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_secs() as i64)
                        .unwrap_or(0);
                    if *size != meta.len() || *modified != now {
                        fail(
                            &mut out,
                            &mut broken,
                            "It changed since the scan. Scan again first.".into(),
                        );
                        continue;
                    }
                }
            }
            let to = op.to.as_deref();
            let (done, logged_to): (Res<()>, Option<String>) = match op.kind {
                OpKind::Recycle => (trash::delete(&op.from).map_err(err), None),
                OpKind::Delete => (std::fs::remove_file(&op.from).map_err(err), None),
                OpKind::Move => {
                    // What is free may have changed since the plan was made.
                    let planned = to.unwrap_or_default();
                    let (dir, _) = sift_core::plan::split_path(planned);
                    let (_, name) = sift_core::plan::split_path(&op.from);
                    let target = sift_core::plan::free_path(dir, name, &exists);
                    (move_file(&op.from, &target), Some(target))
                }
                OpKind::Rename => {
                    let target = to.unwrap_or_default().to_string();
                    let r = if exists(&target) {
                        Err("A file with that name is already there.".to_string())
                    } else {
                        std::fs::rename(&op.from, &target).map_err(err)
                    };
                    (r, Some(target))
                }
            };
            match done {
                Ok(()) => {
                    changed.insert(op.id);
                    let kind = match op.kind {
                        OpKind::Recycle => {
                            out.recycled += 1;
                            "recycled"
                        }
                        OpKind::Delete => {
                            out.deleted += 1;
                            "deleted"
                        }
                        OpKind::Move => {
                            out.moved += 1;
                            "moved"
                        }
                        OpKind::Rename => {
                            out.renamed += 1;
                            "renamed"
                        }
                    };
                    let logged = app.db.lock().unwrap().log_action(
                        kind,
                        &op.from,
                        logged_to.as_deref(),
                        meta.len(),
                        &op.reason,
                    );
                    if let Err(e) = logged {
                        out.failed.push(Failed {
                            path: op.from.clone(),
                            error: format!("Done, but not written in History: {e}"),
                        });
                    }
                }
                Err(e) => fail(&mut out, &mut broken, e),
            }
        }
        // Take what moved away or changed its name out of every remembered result too: it is no
        // longer where the scan saw it.
        let gone: HashSet<String> = changed
            .iter()
            .filter_map(|id| seen.get(id).map(|(p, _, _)| p.to_lowercase()))
            .collect();
        for r in app.results.lock().unwrap().values_mut() {
            let ids: HashSet<u32> = r
                .files
                .iter()
                .filter(|f| gone.contains(&f.path.to_lowercase()))
                .map(|f| f.id)
                .collect();
            r.remove_files(&ids);
        }
        save_cached(&app);
        Ok(out)
    })
    .await
    .map_err(err)?
}

/// Undoes one entry of History: puts a file back from the Recycle Bin, moves a moved file back,
/// or gives a renamed file its old name. A permanent delete cannot be undone.
#[tauri::command]
fn undo(app: State<App>, id: i64) -> Res<()> {
    let entry = app
        .db
        .lock()
        .unwrap()
        .removal(id)
        .map_err(err)?
        .ok_or("Not in the log.")?;
    if entry.restored_at.is_some() {
        return Err("Already undone.".into());
    }
    match entry.kind.as_str() {
        "recycled" => restore_from_bin(&entry.path)?,
        "moved" | "renamed" => {
            let now_at = entry
                .to
                .as_deref()
                .ok_or("History does not say where it went.")?;
            if !exists(now_at) {
                return Err("It is no longer there.".into());
            }
            if exists(&entry.path) {
                return Err("A file with the old name is already in its place.".into());
            }
            if entry.kind == "renamed" {
                std::fs::rename(now_at, &entry.path).map_err(err)?;
            } else {
                move_file(now_at, &entry.path)?;
            }
        }
        _ => return Err("A permanent delete can't be undone.".into()),
    }
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
    Err("Putting back from the Recycle Bin works on Windows only.".into())
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
            app.manage(App {
                db: Mutex::new(db),
                running: Mutex::new(HashMap::new()),
                results: Mutex::new(HashMap::new()),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            overview,
            job_create,
            job_duplicate,
            job_save,
            job_delete,
            job_open,
            job_state_save,
            job_picks,
            preset_save,
            preset_rename,
            preset_delete,
            pick_folder,
            add_folders,
            remove_folder,
            add_skip,
            remove_skip,
            set_setting,
            keep,
            unkeep,
            scan,
            cancel_scan,
            plan_act,
            act,
            undo,
            show_in_folder,
            open_file
        ])
        .run(tauri::generate_context!())
        .expect("Sift could not start");
}
