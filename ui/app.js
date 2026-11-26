// Sift's window. Plain JavaScript, no framework: one state object, pages drawn from it, long
// lists drawn only where they are visible so tens of thousands of files stay smooth.
//
// The window is a row of job tabs, a row of steps (Set up, Results, Act) and the step itself.
// Each job has its own runtime (result, selection, filters); `activate` swaps the active job's
// into `S`, so the result pages read `S.result`, `S.old` and `S.dupes` as before.
'use strict';

const T = window.__TAURI__;
const invoke = (cmd, args) => T.core.invoke(cmd, args);

// ---------- State ----------

const S = {
  view: 'job', // 'job', or one of the pages in the strip: 'windows', 'kept', 'history'
  overview: null,
  jobs: [], // every job's settings, as saved
  jobId: null,
  // The active job's runtime:
  result: null,
  files: new Map(),
  old: null,
  dupes: null,
  f: null, // the job's filters
  act: null,
  ignored: new Set(), // keys of groups hidden as "not duplicates"
  reviewed: new Set(), // keys of groups looked at
};

const RT = new Map(); // job id -> runtime

// The filters of a job are one set, shared by both lists and by Act.
const newOldState = (f) => ({ f, sort: { key: 'size', asc: false }, groupBy: 'none', folded: new Set(), onlySel: false, sel: new Set(), focus: -1, anchor: -1, shownCount: 0 });
const newDupesState = (f) => ({ f, kinds: new Set(), notSure: false, show: 'all', gsort: 'kind', showDismissed: false, hideSingles: false, keys: false, sel: new Set(), focus: -1, anchor: -1, vis: new Map(), onTouch: null });
// What was chosen on the Act step; permanent delete is never remembered.
const newActState = () => ({ sure: 'selected', notSure: 'leave', old: 'leave', removal: 'recycle', moveTo: '', keepStructure: true, moveKept: false, moveKeptTo: '', renameKept: false, dry: false, plan: null });

function rtOf(id) {
  if (!RT.has(id)) { const f = newFilter(); RT.set(id, { result: null, files: new Map(), f, old: newOldState(f), dupes: newDupesState(f), act: newActState(), ignored: new Set(), reviewed: new Set(), loaded: false, scanning: false, progress: null, dropped: 0, saved: '' }); }
  return RT.get(id);
}
const jobById = (id) => S.jobs.find((j) => j.id === id);
const job = () => jobById(S.jobId);

// ---------- Small helpers ----------

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nf = new Intl.NumberFormat();

function size(n) {
  if (n < 1024) return n + ' B';
  const u = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return (n >= 100 ? n.toFixed(0) : n.toFixed(1)) + ' ' + u[i];
}

function ago(secs) {
  if (!secs) return '—';
  const d = Date.now() / 1000 - secs;
  if (d < 60) return 'just now';
  if (d < 3600) return Math.floor(d / 60) + ' min ago';
  if (d < 86400) return Math.floor(d / 3600) + ' h ago';
  const days = Math.floor(d / 86400);
  if (days < 31) return days === 1 ? 'yesterday' : days + ' days ago';
  const months = Math.floor(days / 30.4);
  if (months < 12) return months === 1 ? '1 month ago' : months + ' months ago';
  const y = Math.floor(months / 12);
  return y === 1 ? '1 year ago' : y + ' years ago';
}

const fullDate = (secs) => (secs ? new Date(secs * 1000).toLocaleString() : '');

const KIND_LABEL = { installer: 'Programs & installers', archive: 'Archives', document: 'Documents', disk: 'Disk images', image: 'Images', video: 'Video', audio: 'Audio', torrent: 'Torrents', other: 'Other' };

const REASON = {
  untouched: { label: 'Unused', text: (s) => `Unused ${s.months} months`, tip: () => 'Not opened or changed in that time' },
  installed: { label: 'Installed already', text: () => 'Installed already', tip: (s) => `Installer of “${s.program}”, which is installed` },
  unpacked: { label: 'Already unpacked', text: (s) => `Unpacked in ${s.folder.split(/[\\/]/).filter(Boolean).pop() || s.folder}`, tip: (s) => `What is inside is already on disk, in ${s.folder}` },
  oldArchive: { label: 'Old archive', text: (s) => `Archive, ${s.months} months old`, tip: () => 'An archive older than the limit in Settings' },
  superseded: { label: 'Newer version here', text: () => 'Newer version here', tip: (s) => `A newer version is here: ${s.newer}` },
};

// Duplicates are what a person means by one: the same file twice (same bytes, same name apart
// from a copy mark), or an older version of the same installer. The rest is "not sure".
const GROUP = {
  copies: { label: 'Copies', main: true, tip: 'Byte for byte the same, with the same name or a copy mark like “1”, “(1)” or “- Copy”' },
  versions: { label: 'Installer versions', main: true, tip: 'Installers of the same program with different version numbers' },
  sameContent: { label: 'Same content, other name', tip: 'Byte for byte the same, but the names are unrelated. Could be a renamed copy, or files that happen to be equal.' },
  sameName: { label: 'Same name, other content', tip: 'The same name (copy marks aside), but the content differs: perhaps changed later' },
  similarName: { label: 'Similar names', tip: 'Names that are nearly the same, content differs' },
};

let toastTimer = null;
function toast(html, action) {
  const t = $('#toast');
  t.innerHTML = `<span>${html}</span>` + (action ? `<button>${esc(action.label)}</button>` : '');
  t.hidden = false;
  if (action) t.querySelector('button').onclick = () => { t.hidden = true; action.run(); };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), action ? 9000 : 4500);
}

function fail(e) {
  toast(esc(typeof e === 'string' ? e : (e && e.message) || 'Something went wrong.'));
}

// ---------- Preferences kept between runs (lists stored as JSON settings) ----------

function pref(key, fallback) {
  try {
    const v = S.overview && S.overview.settings[key];
    return v === undefined ? fallback : JSON.parse(v);
  } catch (e) { return fallback; }
}

async function savePref(key, value) {
  const v = JSON.stringify(value);
  S.overview.settings[key] = v;
  await invoke('set_setting', { key, value: v }).catch(fail);
  protectCache = null;
}

// Protected paths can never be selected: a safety net next to the keep-list.
let protectCache = null;
function isProtected(f) {
  if (!protectCache) protectCache = pref('protect', []).map(patternRegex).filter(Boolean);
  return protectCache.some((re) => re.test(f.path));
}
const canSelect = (f) => !!f && !f.kept && !isProtected(f);

// ---------- Loading and jobs ----------

async function loadOverview(withJobs) {
  S.overview = await invoke('overview');
  if (withJobs) S.jobs = S.overview.jobs;
}

function activate(id) {
  S.jobId = id;
  const r = rtOf(id);
  S.result = r.result;
  S.files = r.files;
  S.old = r.old;
  S.dupes = r.dupes;
  S.f = r.f;
  S.act = r.act;
  S.ignored = r.ignored;
  S.reviewed = r.reviewed;
  closePopover();
}

// Takes what the app says about a job (its result, selection and reviewed groups) into its runtime.
function applyOpened(id, p) {
  const r = rtOf(id);
  r.result = p.result;
  r.files = new Map(p.result ? p.result.files.map((f) => [f.id, f]) : []);
  const byPath = new Map([...r.files.values()].map((f) => [f.path.toLowerCase(), f.id]));
  const pick = (paths) => new Set((paths || []).map((x) => byPath.get(x.toLowerCase())).filter((x) => x !== undefined));
  r.old.sel = pick(p.state.selOld);
  r.dupes.sel = pick(p.state.selDupes);
  for (const st of [r.old, r.dupes]) {
    for (const x of [...st.sel]) if (!canSelect(r.files.get(x))) st.sel.delete(x);
    st.focus = -1;
    st.anchor = -1;
  }
  r.ignored = new Set(p.state.ignored || []);
  r.reviewed = new Set(p.state.reviewed || []);
  r.dropped = p.dropped || 0;
  r.loaded = true;
  r.saved = JSON.stringify(stateOf(r));
  if (id === S.jobId) activate(id);
}

async function reloadJob(id) {
  const p = JSON.parse(await invoke('job_open', { id }));
  applyOpened(id, p);
  if (p.dropped) toast(`${nf.format(p.dropped)} file${p.dropped === 1 ? ' was' : 's were'} gone or changed since the scan and left out.`);
}

// What is remembered about a job's result: selection by path, reviewed and ignored by group key.
function stateOf(r) {
  const paths = (st) => [...st.sel].map((id) => r.files.get(id)?.path).filter(Boolean);
  return { selOld: paths(r.old), selDupes: paths(r.dupes), reviewed: [...r.reviewed], ignored: [...r.ignored] };
}

let saveTimer = null;
async function saveState(id) {
  const r = RT.get(id);
  if (!r || !r.loaded) return;
  const state = stateOf(r);
  const json = JSON.stringify(state);
  if (json === r.saved) return;
  r.saved = json;
  await invoke('job_state_save', { id, state }).catch(() => {});
}
function queueSave() {
  const id = S.jobId;
  clearTimeout(saveTimer);
  if (id != null) saveTimer = setTimeout(() => saveState(id), 400);
}
async function flushState() {
  clearTimeout(saveTimer);
  if (S.jobId != null) await saveState(S.jobId);
}
function selectionChanged() {
  queueSave();
  renderSteps();
}

async function saveJob(j) {
  await invoke('job_save', { job: j }).catch(fail);
}

async function openJob(id) {
  await flushState();
  closePopover();
  S.view = 'job';
  activate(id);
  const r = rtOf(id);
  if (!r.loaded) {
    try { await reloadJob(id); } catch (e) { fail(e); }
  }
  invoke('set_setting', { key: 'activeJob', value: String(id) }).catch(() => {});
  render();
}

async function newJob() {
  try {
    const j = await invoke('job_create');
    S.jobs.push(j);
    await openJob(j.id);
  } catch (e) { fail(e); }
}

async function duplicateJob(id) {
  try {
    const j = await invoke('job_duplicate', { id });
    S.jobs.push(j);
    await openJob(j.id);
  } catch (e) { fail(e); }
}

async function deleteJob(id) {
  const j = jobById(id);
  if (!await askOnce(`Delete “${j.name}”?`, 'Its folders choice, settings and saved results go. The files themselves are not touched.', 'Delete job')) return;
  await invoke('job_delete', { id }).catch(fail);
  RT.delete(id);
  S.jobs = S.jobs.filter((x) => x.id !== id);
  if (!S.jobs.length) S.jobs.push(await invoke('job_create'));
  await openJob(S.jobs[0].id);
}

async function setStep(step) {
  const j = job();
  if (!j) return;
  await flushState();
  S.view = 'job';
  j.step = step;
  saveJob(j);
  render();
}

// A question asked once, in the shared dialog. Resolves true when confirmed.
function askOnce(title, text, okLabel, danger = true) {
  return new Promise((resolve) => {
    const d = $('#confirm');
    d.innerHTML = `<div class="dh"><h2>${esc(title)}</h2><p>${esc(text)}</p></div>
      <div class="df"><button class="btn" id="aNo">Cancel</button><button class="btn ${danger ? 'danger' : 'primary'}" id="aYes">${esc(okLabel)}</button></div>`;
    d.onclose = () => resolve(false);
    $('#aNo', d).onclick = () => d.close();
    $('#aYes', d).onclick = () => { d.onclose = null; d.close(); resolve(true); };
    d.showModal();
    $('#aNo', d).focus();
  });
}

// Asks for a line of text in the shared dialog. Resolves with it, or null.
function askText(title, label, value, okLabel) {
  return new Promise((resolve) => {
    const d = $('#confirm');
    d.innerHTML = `<div class="dh"><h2>${esc(title)}</h2></div>
      <div class="dbody"><label class="field">${esc(label)}<input id="aText" value="${esc(value)}"></label></div>
      <div class="df"><button class="btn" id="aNo">Cancel</button><button class="btn primary" id="aYes">${esc(okLabel)}</button></div>`;
    d.onclose = () => resolve(null);
    const done = () => { const v = $('#aText', d).value.trim(); if (!v) return; d.onclose = null; d.close(); resolve(v); };
    $('#aNo', d).onclick = () => d.close();
    $('#aYes', d).onclick = done;
    $('#aText', d).onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); done(); } };
    d.showModal();
    $('#aText', d).select();
  });
}

// ---------- Scanning ----------

const pctOf = (p) => (p && p.phase === 'comparing' ? (p.total ? Math.min(100, Math.round((p.done / p.total) * 100)) : 100) : null);

function progressText(p) {
  if (!p) return 'Starting…';
  if (p.phase === 'looking') return `Looking… ${nf.format(p.files)} files`;
  if (p.phase === 'comparing') return `Comparing contents… ${pctOf(p)}%`;
  return 'Checking what is old…';
}

async function scanJob(id) {
  const j = jobById(id);
  const r = rtOf(id);
  if (r.scanning) return;
  if (!j.folders.some((f) => f.active)) { toast('Tick at least one folder to look in first.'); return; }
  if (id === S.jobId) await flushState();
  r.scanning = true;
  r.progress = null;
  renderTabs();
  updateScanArea();
  try {
    const p = JSON.parse(await invoke('scan', { jobId: id }));
    if (p.result) {
      applyOpened(id, p);
      toast(`${esc(j.name)}: looked at ${nf.format(p.result.stats.filesSeen)} files (${size(p.result.stats.bytesSeen)}).`);
      // Read the job again: folders may have changed while the scan ran, and saving the old copy would undo that.
      const now = jobById(id);
      if (now && S.view === 'job' && S.jobId === id && now.step === 'setup') { now.step = 'results'; saveJob(now); }
    } else {
      toast('Scan stopped. The earlier results are still here.');
    }
  } catch (e) {
    fail(e);
  }
  r.scanning = false;
  r.progress = null;
  await loadOverview();
  renderTabs();
  if (S.view === 'job' && S.jobId === id) render();
}

function stopScan(id) {
  invoke('cancel_scan', { jobId: id });
}

// ---------- Tabs and steps ----------

const ringHtml = (pct) => {
  const c = 2 * Math.PI * 7;
  const arc = pct == null ? c * 0.3 : (c * pct) / 100;
  return `<svg class="ring ${pct == null ? 'spin' : ''}" viewBox="0 0 18 18" aria-hidden="true"><circle class="track" cx="9" cy="9" r="7"/><circle class="arc" cx="9" cy="9" r="7" stroke-dasharray="${arc.toFixed(1)} ${c.toFixed(1)}"/></svg>`;
};

// Old files plus groups of duplicates not looked at yet: what is left to go through.
function jobLeft(j) {
  const r = RT.get(j.id);
  let old, groups, reviewed;
  if (r && r.loaded && r.result) {
    old = r.result.old.length;
    groups = r.result.groups.filter((g) => GROUP[g.kind] && GROUP[g.kind].main).length;
    reviewed = r.reviewed.size;
  } else {
    const c = S.overview && S.overview.counts[j.id];
    if (!c) return 0;
    old = c.old; groups = c.groups; reviewed = c.reviewed;
  }
  return (j.findOld ? old : 0) + (j.findDupes ? Math.max(0, groups - reviewed) : 0);
}

function badgeHtml(j) {
  const r = RT.get(j.id);
  if (r && r.scanning) return ringHtml(pctOf(r.progress));
  const n = jobLeft(j);
  return n ? `<span class="badge" title="${nf.format(n)} left to go through">${nf.format(n)}</span>` : '';
}

function updateBadge(id) {
  const el = document.querySelector(`[data-tb="${id}"]`);
  const j = jobById(id);
  if (el && j) el.innerHTML = badgeHtml(j);
}

function renderTabs() {
  $('#tabs').innerHTML = S.jobs.map((j) => {
    const on = S.view === 'job' && j.id === S.jobId;
    return `<button class="tab ${on ? 'on' : ''}" role="tab" aria-selected="${on}" data-job="${j.id}" title="${esc(j.name)}"><span class="tname">${esc(j.name)}</span><span class="tb" data-tb="${j.id}">${badgeHtml(j)}</span></button>`;
  }).join('') + '<button class="tab add" id="addJob" title="New job" aria-label="New job">+</button>';
  document.querySelectorAll('#strip [data-view]').forEach((b) => b.classList.toggle('on', b.dataset.view === S.view));
}

const STEPS = [['setup', 'Set up'], ['results', 'Results'], ['act', 'Act']];

function renderSteps() {
  const el = $('#steps');
  const j = job();
  el.hidden = S.view !== 'job' || !j;
  if (el.hidden) return;
  const n = S.result ? selectedForAct().length : 0;
  el.innerHTML = STEPS.map(([k, label], i) =>
    `${i ? '<span class="sep" aria-hidden="true">›</span>' : ''}<button class="step ${j.step === k ? 'on' : ''}" data-step="${k}" ${j.step === k ? 'aria-current="step"' : ''}><span class="num">${i + 1}</span>${label}${k === 'act' && n ? `<span class="n">${nf.format(n)} selected</span>` : ''}</button>`).join('');
}

// ---------- Router ----------

async function go(view) {
  closePopover();
  await flushState();
  S.view = view;
  render();
}

function render() {
  renderTabs();
  renderSteps();
  const main = $('#main');
  main.innerHTML = '';
  if (S.view === 'job' && job()) {
    const j = job();
    ({ setup: renderSetup, results: renderResults, act: renderAct })[j.step || 'setup'](main);
  } else {
    ({ windows: renderWindows, kept: renderKept, history: renderHistory })[S.view](main);
  }
}

const SEARCH_ICON = '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/></svg>';

// The results step shows one list at a time; a switch picks it when the job finds both.
const curList = (j) => (j.findOld && !j.findDupes ? 'old' : j.findDupes && !j.findOld ? 'dupes' : j.list === 'dupes' ? 'dupes' : 'old');

function listSwitch() {
  const j = job();
  if (S.view !== 'job' || !j || j.step !== 'results' || !(j.findOld && j.findDupes) || !S.result) return '';
  const l = curList(j);
  const mainGroups = S.result.groups.filter((g) => GROUP[g.kind].main).length;
  return `<div class="seg" role="tablist" aria-label="List"><button class="${l === 'old' ? 'on' : ''}" data-list="old">Old downloads<span class="n">${nf.format(S.result.old.length)}</span></button><button class="${l === 'dupes' ? 'on' : ''}" data-list="dupes">Duplicates<span class="n">${nf.format(mainGroups)}</span></button></div>`;
}

function header(title, sub, extra = '') {
  return `<div class="head"><div><h1>${esc(title)}</h1><div class="sub">${sub}</div></div><div class="grow"></div>${listSwitch()}${extra}</div>`;
}

function noResult(main, title) {
  main.innerHTML = header(title, '') + `<div class="page"><div class="empty"><h2>Nothing scanned yet</h2>
    <p>Choose the folders and what to find on Set up, then press Scan.</p>
    <button class="btn primary" id="emptySetup">Go to Set up</button></div></div>`;
  $('#emptySetup').onclick = () => setStep('setup');
}

function renderResults(main) {
  const j = job();
  (curList(j) === 'old' ? renderOld : renderDupes)(main);
  const r = rtOf(j.id);
  if (S.result && r.dropped) {
    main.insertAdjacentHTML('afterbegin', `<div class="notice">${nf.format(r.dropped)} file${r.dropped === 1 ? ' was' : 's were'} gone or changed since the scan and left out.</div>`);
  }
  main.querySelectorAll('[data-list]').forEach((b) => (b.onclick = () => {
    j.list = b.dataset.list;
    saveJob(j);
    render();
  }));
}

// ---------- Virtual list ----------

// Draws only the rows in view. `rowHtml(i)` gives a row's inner html and class.
function virtualList(scroller, count, rowHtml) {
  const spacer = document.createElement('div');
  spacer.className = 'spacer';
  scroller.innerHTML = '';
  scroller.appendChild(spacer);
  const rh = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--row'), 10) || 40;
  spacer.style.height = count * rh + 'px';
  let frame = 0;
  const draw = () => {
    frame = 0;
    const top = scroller.scrollTop;
    const h = scroller.clientHeight || 600;
    const first = Math.max(0, Math.floor(top / rh) - 8);
    const last = Math.min(count, Math.ceil((top + h) / rh) + 8);
    let html = '';
    for (let i = first; i < last; i++) {
      const r = rowHtml(i);
      html += `<div class="row ${r.cls}" data-i="${i}" style="top:${i * rh}px">${r.html}</div>`;
    }
    spacer.innerHTML = html;
  };
  scroller.onscroll = () => { if (!frame) frame = requestAnimationFrame(draw); };
  draw();
  return {
    redraw: draw,
    reveal(i) {
      const top = i * rh;
      if (top < scroller.scrollTop) scroller.scrollTop = top;
      else if (top + rh > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = top + rh - scroller.clientHeight;
      draw();
    },
  };
}

// Click, Shift-click and Ctrl-click on rows; arrows, Space, Ctrl+A, Esc and Delete on the list.
function selectionBehaviour(scroller, st, rows, isSelectable, idOf, list, onChange, onDelete) {
  const toggle = (i, on) => {
    const id = idOf(i);
    if (id === undefined || !isSelectable(i)) return;
    if (on === undefined) on = !st.sel.has(id);
    on ? st.sel.add(id) : st.sel.delete(id);
    if (st.onTouch) st.onTouch(id);
  };
  const range = (a, b, on) => {
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) toggle(i, on);
  };
  scroller.onclick = (e) => {
    const rowEl = e.target.closest('.row');
    if (!rowEl || e.target.closest('button')) return;
    const i = Number(rowEl.dataset.i);
    if (idOf(i) === undefined) return;
    if (e.shiftKey && st.anchor >= 0) {
      range(st.anchor, i, true);
    } else {
      toggle(i);
      st.anchor = i;
    }
    st.focus = i;
    scroller.focus({ preventScroll: true });
    list.redraw();
    onChange();
  };
  scroller.ondblclick = (e) => {
    const rowEl = e.target.closest('.row');
    if (!rowEl || e.target.closest('button')) return;
    const id = idOf(Number(rowEl.dataset.i));
    if (id !== undefined) invoke('open_file', { path: S.files.get(id).path }).catch(fail);
  };
  scroller.onkeydown = (e) => {
    const n = rows().length;
    if (!n) return;
    const move = (d) => {
      let i = st.focus < 0 ? (d > 0 ? -1 : n) : st.focus;
      do { i += d; } while (i >= 0 && i < n && idOf(i) === undefined);
      if (i < 0 || i >= n) return;
      if (e.shiftKey) {
        if (st.anchor < 0) st.anchor = st.focus >= 0 ? st.focus : i;
        range(st.anchor, i, true);
        onChange();
      }
      st.focus = i;
      list.reveal(i);
    };
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    else if (e.key === ' ' && st.focus >= 0) { e.preventDefault(); toggle(st.focus); st.anchor = st.focus; list.redraw(); onChange(); }
    else if ((e.key === 'a' || e.key === 'A') && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      for (let i = 0; i < n; i++) toggle(i, true);
      list.redraw(); onChange();
    } else if (e.key === 'Escape') { st.sel.clear(); list.redraw(); onChange(); }
    else if (e.key === 'Delete' && st.sel.size) { e.preventDefault(); onDelete(); }
  };
}

function rowActions(id) {
  return `<div class="rowacts"><button class="linkbtn quiet" data-act="show" data-id="${id}" title="Show in File Explorer">Show</button><button class="linkbtn quiet" data-act="keep" data-id="${id}" title="Never suggest this file again">Keep</button><button class="linkbtn quiet" data-act="hide" data-id="${id}" title="Take this folder out of view: files in it are not shown, selected or acted on">Hide folder</button></div>`;
}

function wireRowActions(scroller, after, F) {
  scroller.addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    e.stopPropagation();
    const f = S.files.get(Number(b.dataset.id));
    if (!f) return;
    if (b.dataset.act === 'show') invoke('show_in_folder', { path: f.path }).catch(fail);
    if (b.dataset.act === 'keep') await keepFiles([f.id], after);
    if (b.dataset.act === 'hide') {
      F.hideDirs.add(f.dir);
      for (const st of [S.old, S.dupes]) for (const id of [...st.sel]) if (S.files.get(id)?.dir === f.dir) st.sel.delete(id);
      toast(`Hiding ${esc(f.dir)}. “${F.hideDirs.size} folder${F.hideDirs.size === 1 ? '' : 's'} hidden” in the bar shows it again.`);
      after();
    }
  });
}

async function keepFiles(ids, after) {
  const paths = ids.map((id) => S.files.get(id).path);
  try {
    await invoke('keep', { paths });
    for (const id of ids) S.files.get(id).kept = true;
    if (S.result) S.result.old = S.result.old.filter((o) => !ids.includes(o.file));
    for (const id of ids) { S.old.sel.delete(id); S.dupes.sel.delete(id); }
    await loadOverview();
    toast(`${ids.length === 1 ? 'Kept: it' : nf.format(ids.length) + ' files kept: they'} won't be suggested again.`, {
      label: 'Undo',
      run: async () => {
        await invoke('unkeep', { paths });
        await flushState();
        await reloadJob(S.jobId);
        await loadOverview();
        render();
      },
    });
    after();
  } catch (e) { fail(e); }
}

function patternRegex(p) {
  const norm = p.trim().replace(/\//g, '\\');
  if (!norm) return null;
  const body = norm.split('').map((c) => (c === '*' ? '.*' : c === '?' ? '.' : c.replace(/[.+^${}()|[\]\\]/g, '\\$&'))).join('');
  // A pattern without wildcards matches anywhere in the path.
  return new RegExp(/[*?]/.test(norm) ? '^' + body + '$' : body, 'i');
}

function selbarHtml(st, extraButtons) {
  return `<div class="selbar">
    <div class="what" id="selWhat"></div>
    <button class="btn small" id="selClear">Clear</button>
    <button class="btn small" id="selInvert" title="Select what is shown and not selected; unselect the rest">Invert</button>
    <div class="pattern" title="Files by path, with * for anything. For example: *\\Downloads\\old\\*">
      <input id="patIn" placeholder="Path, like *\\Old\\*">
      <button class="btn small" id="patSel">Select</button><button class="btn small" id="patUnsel">Unselect</button>
      <button class="btn small" id="patProtect" title="Never let files matching this path be selected (kept between runs; see Kept and protected)">Protect</button>
    </div>
    <div class="grow"></div>
    ${extraButtons}
    <button class="btn" id="selKeep">Keep</button>
    <button class="btn primary" id="selRecycle" title="Go to Act to look over what goes and remove it">Next: Act ›</button>
  </div>`;
}

function wireSelbar(main, st, visibleIds, refresh, recycleFn) {
  const update = () => {
    const ids = [...st.sel];
    const bytes = ids.reduce((a, id) => a + (S.files.get(id)?.size || 0), 0);
    $('#selWhat', main).innerHTML = ids.length ? `${nf.format(ids.length)} selected <span>· ${size(bytes)}</span>` : '<span>Nothing selected</span>';
    $('#selRecycle', main).disabled = !ids.length;
    queueSave();
    $('#selKeep', main).disabled = !ids.length;
    $('#selClear', main).disabled = !ids.length;
  };
  $('#selClear', main).onclick = () => { st.sel.clear(); refresh(); };
  $('#selInvert', main).onclick = () => {
    for (const id of visibleIds()) {
      if (st.sel.has(id)) st.sel.delete(id);
      else if (canSelect(S.files.get(id))) st.sel.add(id);
    }
    refresh();
  };
  $('#patProtect', main).onclick = async () => {
    const v = $('#patIn', main).value.trim();
    if (!v) return;
    const list = pref('protect', []);
    if (!list.includes(v)) list.push(v);
    await savePref('protect', list);
    let n = 0;
    for (const id of [...st.sel]) if (isProtected(S.files.get(id))) { st.sel.delete(id); n++; }
    toast(`Protected: files matching ${esc(v)} can't be selected.${n ? ` ${n} were unselected.` : ''}`);
    render();
  };
  $('#selKeep', main).onclick = () => keepFiles([...st.sel], () => render());
  $('#selRecycle', main).onclick = recycleFn;
  const applyPattern = (on) => {
    const re = patternRegex($('#patIn', main).value);
    if (!re) return;
    let n = 0;
    for (const id of visibleIds()) {
      const f = S.files.get(id);
      if (!f) continue;
      if (re.test(f.path) && (!on || canSelect(f))) { on ? st.sel.add(id) : st.sel.delete(id); n++; }
    }
    toast(n ? `${on ? 'Selected' : 'Unselected'} ${nf.format(n)} files matching that path.` : 'No file shown here matches that path.');
    refresh();
  };
  $('#patSel', main).onclick = () => applyPattern(true);
  $('#patUnsel', main).onclick = () => applyPattern(false);
  $('#patIn', main).onkeydown = (e) => { if (e.key === 'Enter') applyPattern(true); };
  return update;
}

// ---------- Filters (one set per job, shared by Results and Act) ----------

const SIZE_STEPS = [0, 1024, 100 * 1024, 1 << 20, 10 << 20, 100 << 20, 1 << 30, 10 * 2 ** 30, Infinity];
const AGE_STEPS = [0, 1, 7, 30, 91, 182, 365, 730, 1825, Infinity]; // days
const ageLabel = (d) => (d === 0 || d === Infinity ? 'any' : d < 7 ? d + ' day' : d < 30 ? d / 7 + (d === 7 ? ' week' : ' weeks') : d < 365 ? Math.round(d / 30.4) + (d < 60 ? ' month' : ' months') : d / 365 + (d === 365 ? ' year' : ' years'));

function newFilter() {
  return { query: '', kinds: new Set(), exts: new Set(), dirs: new Set(), origins: new Set(), reasons: new Set(), hideDirs: new Set(), sizeMin: 0, sizeMax: SIZE_STEPS.length - 1, olderThan: 0, newerThan: AGE_STEPS.length - 1 };
}

const extOf = (f) => (f.ext ? '.' + f.ext : '(no extension)');
const originOf = (f) => f.origin || '(not known)';
const FACETS = {
  kinds: { label: 'Type', of: (f) => f.kind, show: (v) => KIND_LABEL[v] || v },
  exts: { label: 'Extension', of: extOf, show: (v) => v },
  dirs: { label: 'Folder', of: (f) => f.dir, show: (v) => v },
  origins: { label: 'From', of: originOf, show: (v) => v },
};

const rangesActive = (F) => F.sizeMin > 0 || F.sizeMax < SIZE_STEPS.length - 1 || F.olderThan > 0 || F.newerThan < AGE_STEPS.length - 1;
function filterActive(F) {
  return F.query.trim() || F.kinds.size || F.exts.size || F.dirs.size || F.origins.size || F.reasons.size || F.hideDirs.size || rangesActive(F);
}

// The search box: plain text matches anywhere in the path; * and ? work as wildcards.
let searchMemo = ['', null];
function searchTest(q) {
  q = q.trim().toLowerCase();
  if (!q) return null;
  if (searchMemo[0] === q) return searchMemo[1];
  let fn;
  if (/[*?]/.test(q)) {
    const re = new RegExp(q.split('').map((c) => (c === '*' ? '.*' : c === '?' ? '.' : c.replace(/[.+^${}()|[\]\\]/g, '\\$&'))).join(''), 'i');
    fn = (p) => re.test(p);
  } else fn = (p) => p.toLowerCase().includes(q);
  searchMemo = [q, fn];
  return fn;
}

// Does one file pass the filters? `dateOf` is the date the age sliders look at; `qt` the search
// test (null when the search is left out or empty).
function fileMatches(f, F, dateOf, qt) {
  if (qt && !qt(f.path)) return false;
  if (F.hideDirs.size && F.hideDirs.has(f.dir)) return false;
  for (const k of Object.keys(FACETS)) if (F[k].size && !F[k].has(FACETS[k].of(f))) return false;
  if (f.size < SIZE_STEPS[F.sizeMin] || f.size > SIZE_STEPS[F.sizeMax]) return false;
  const days = (Date.now() / 1000 - dateOf(f)) / 86400;
  if (days < AGE_STEPS[F.olderThan]) return false;
  if (AGE_STEPS[F.newerThan] !== Infinity && days > AGE_STEPS[F.newerThan]) return false;
  return true;
}

// The one bar above Results and Act: search, filters, counts, and (on Act) Dry run and Go.
// `extra` holds buttons that open list-specific panels; `actions` the buttons at the right.
function topbarHtml(F, extra, actions) {
  const pop = (k) => `<button class="btn small popbtn ${F[k].size ? 'on' : ''}" data-pop="${k}">${FACETS[k].label}${F[k].size ? ` <span class="n">${F[k].size}</span>` : ''} ▾</button>`;
  return `<div class="topbar">
    <label class="search" title="* stands for anything, ? for one character">${SEARCH_ICON}<input id="q" placeholder="Search name or folder" value="${esc(F.query)}"></label>
    ${pop('kinds')}${pop('exts')}${pop('dirs')}${pop('origins')}
    <button class="btn small popbtn ${rangesActive(F) ? 'on' : ''}" data-pop="ranges">Size and date ▾</button>${extra || ''}
    <button class="chipbtn on" id="unhideDirs" ${F.hideDirs.size ? '' : 'hidden'} title="Folders you filtered out of view. Press to show them again.">${F.hideDirs.size} folder${F.hideDirs.size === 1 ? '' : 's'} hidden ✕</button>
    <button class="linkbtn" id="clearFilters" ${filterActive(F) ? '' : 'hidden'}>Clear all filters</button>
    <span class="grow"></span><span class="counts" id="counts" aria-live="polite"></span>${actions ? `<span class="barbtns">${actions}</span>` : ''}
  </div>`;
}

// Wires the bar. `baseFiles()` gives the files the choice lists count over; `onChange` runs
// after any filter changed; `dateWord` names the date the age sliders look at.
function wireTopbar(main, F, baseFiles, onChange, dateWord) {
  const changed = () => {
    $('#clearFilters', main).hidden = !filterActive(F);
    onChange();
  };
  $('#q', main).oninput = (e) => { F.query = e.target.value; changed(); };
  $('#clearFilters', main).onclick = () => {
    Object.assign(F, newFilter());
    render();
  };
  $('#unhideDirs', main).onclick = () => { F.hideDirs.clear(); render(); };
  main.querySelectorAll('[data-pop]').forEach((b) => (b.onclick = (e) => {
    e.stopPropagation();
    const k = b.dataset.pop;
    if (k === 'ranges') {
      openRanges(b, F, dateWord, () => { b.classList.toggle('on', !!rangesActive(F)); changed(); });
      return;
    }
    openFacet(b, F, k, baseFiles, () => {
      const n = F[k].size;
      b.classList.toggle('on', n > 0);
      b.innerHTML = `${FACETS[k].label}${n ? ` <span class="n">${n}</span>` : ''} ▾`;
      changed();
    });
  }));
}

// A small panel under a button, closed by a click outside it.
function openPanel(btn, width, fill) {
  closePopover();
  const pop = document.createElement('div');
  pop.className = 'popover';
  pop.style.width = width + 'px';
  document.body.appendChild(pop);
  fill(pop);
  const r = btn.getBoundingClientRect();
  pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8)) + 'px';
  pop.style.top = r.bottom + 4 + 'px';
  setTimeout(() => document.addEventListener('mousedown', outside), 0);
  function outside(e) { if (!pop.contains(e.target) && !btn.contains(e.target)) closePopover(); }
  closePopover.current = () => { pop.remove(); document.removeEventListener('mousedown', outside); };
  return pop;
}
function closePopover() { if (closePopover.current) { closePopover.current(); closePopover.current = null; } }

// A list of choices with counts and a search box, under its button.
function openFacet(btn, F, key, baseFiles, onChange) {
  const counts = new Map();
  for (const f of baseFiles()) {
    const v = FACETS[key].of(f);
    counts.set(v, (counts.get(v) || 0) + 1);
  }
  const all = [...counts.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
  const pop = openPanel(btn, 360, (pop) => {
    pop.innerHTML = `<input class="popq" placeholder="Find ${esc(FACETS[key].label.toLowerCase())}"><div class="popl"></div>
      <div class="popf"><button class="linkbtn quiet" data-none>Clear</button><span class="grow"></span><button class="btn small" data-done>Done</button></div>`;
  });
  const list = $('.popl', pop);
  const draw = () => {
    const q = $('.popq', pop).value.trim().toLowerCase();
    const shown = all.filter(([v]) => !q || String(FACETS[key].show(v)).toLowerCase().includes(q)).slice(0, 400);
    list.innerHTML = shown.length ? shown.map(([v, n], i) => `<label class="popi"><input type="checkbox" class="check" data-i="${i}" ${F[key].has(v) ? 'checked' : ''}><span class="p" title="${esc(FACETS[key].show(v))}">${esc(FACETS[key].show(v))}</span><span class="n">${nf.format(n)}</span></label>`).join('') : '<div class="empty-list">Nothing found.</div>';
    list.querySelectorAll('input').forEach((c) => (c.onchange = () => {
      const v = shown[Number(c.dataset.i)][0];
      c.checked ? F[key].add(v) : F[key].delete(v);
      onChange();
    }));
  };
  $('.popq', pop).oninput = draw;
  $('[data-none]', pop).onclick = () => { F[key].clear(); draw(); onChange(); };
  $('[data-done]', pop).onclick = closePopover;
  draw();
  $('.popq', pop).focus();
}

// Size and age sliders in a panel.
function openRanges(btn, F, dateWord, onChange) {
  const sizeLabel = (i, end) => (i === 0 && !end ? 'no minimum' : SIZE_STEPS[i] === Infinity ? 'no maximum' : size(SIZE_STEPS[i]));
  const pop = openPanel(btn, 420, (pop) => {
    pop.classList.add('ranges');
    pop.innerHTML = `<div class="rangerow"><b>Size</b>
        <div class="slide">from <input type="range" id="sizeMin" min="0" max="${SIZE_STEPS.length - 2}" value="${F.sizeMin}"><output id="sizeMinOut">${sizeLabel(F.sizeMin)}</output></div>
        <div class="slide">to <input type="range" id="sizeMax" min="1" max="${SIZE_STEPS.length - 1}" value="${F.sizeMax}"><output id="sizeMaxOut">${sizeLabel(F.sizeMax, true)}</output></div></div>
      <div class="rangerow"><b>${esc(dateWord)}</b>
        <div class="slide">more than <input type="range" id="older" min="0" max="${AGE_STEPS.length - 2}" value="${F.olderThan}"><output id="olderOut">${ageLabel(AGE_STEPS[F.olderThan])}</output> ago</div>
        <div class="slide">less than <input type="range" id="newer" min="1" max="${AGE_STEPS.length - 1}" value="${F.newerThan}"><output id="newerOut">${ageLabel(AGE_STEPS[F.newerThan])}</output> ago</div></div>
      <div class="popf"><button class="linkbtn quiet" id="rangeReset">Reset</button><span class="grow"></span><button class="btn small" data-done>Done</button></div>`;
  });
  const range = (id, key, label, fix) => {
    $('#' + id, pop).oninput = (e) => {
      F[key] = Number(e.target.value);
      fix();
      $('#' + id + 'Out', pop).textContent = label(F[key]);
      onChange();
    };
  };
  range('sizeMin', 'sizeMin', (i) => sizeLabel(i), () => { if (F.sizeMax <= F.sizeMin) { F.sizeMax = F.sizeMin + 1; $('#sizeMax', pop).value = F.sizeMax; $('#sizeMaxOut', pop).textContent = sizeLabel(F.sizeMax, true); } });
  range('sizeMax', 'sizeMax', (i) => sizeLabel(i, true), () => { if (F.sizeMin >= F.sizeMax) { F.sizeMin = F.sizeMax - 1; $('#sizeMin', pop).value = F.sizeMin; $('#sizeMinOut', pop).textContent = sizeLabel(F.sizeMin); } });
  range('older', 'olderThan', (i) => ageLabel(AGE_STEPS[i]), () => { if (F.newerThan <= F.olderThan) { F.newerThan = F.olderThan + 1; $('#newer', pop).value = F.newerThan; $('#newerOut', pop).textContent = ageLabel(AGE_STEPS[F.newerThan]); } });
  range('newer', 'newerThan', (i) => ageLabel(AGE_STEPS[i]), () => { if (F.olderThan >= F.newerThan) { F.olderThan = F.newerThan - 1; $('#older', pop).value = F.olderThan; $('#olderOut', pop).textContent = ageLabel(AGE_STEPS[F.olderThan]); } });
  $('#rangeReset', pop).onclick = () => {
    Object.assign(F, { sizeMin: 0, sizeMax: SIZE_STEPS.length - 1, olderThan: 0, newerThan: AGE_STEPS.length - 1 });
    closePopover();
    onChange();
  };
  $('[data-done]', pop).onclick = closePopover;
}

// ---------- Resizable columns ----------

// Each column has a width you can drag at its right edge; widths are remembered per list.
function columns(table, key, defs) {
  let widths;
  try { widths = JSON.parse(localStorage.getItem('sift.cols.' + key)); } catch (e) { widths = null; }
  if (!Array.isArray(widths) || widths.length !== defs.length) widths = defs.map((d) => d.w);
  const apply = () => {
    const tpl = widths.map((w, i) => (i === widths.length - 1 ? `minmax(${w}px, 1fr)` : w + 'px')).join(' ');
    table.style.setProperty('--cols', tpl);
    // The table scrolls sideways when its columns are wider than the window.
    table.style.setProperty('--tw', widths.reduce((a, w) => a + w, 0) + widths.length * 12 + 24 + 'px');
  };
  const save = () => { try { localStorage.setItem('sift.cols.' + key, JSON.stringify(widths)); } catch (e) { /* not kept */ } };
  apply();
  table.querySelectorAll('.grip').forEach((g) => {
    const i = Number(g.dataset.col);
    g.onclick = (e) => e.stopPropagation();
    g.ondblclick = (e) => { e.stopPropagation(); widths[i] = defs[i].w; apply(); save(); };
    g.onpointerdown = (e) => {
      e.preventDefault();
      e.stopPropagation();
      g.setPointerCapture(e.pointerId);
      const startX = e.clientX, startW = widths[i];
      document.body.classList.add('resizing');
      g.onpointermove = (m) => { widths[i] = Math.max(defs[i].min || 48, startW + m.clientX - startX); apply(); };
      g.onpointerup = () => { g.onpointermove = null; document.body.classList.remove('resizing'); save(); };
    };
  });
}

function headCells(defs, st) {
  return defs.map((d, i) => {
    const sort = d.sort && st.sort ? `sort ${st.sort.key === d.sort ? 'on' : ''} ${st.sort.key === d.sort && st.sort.asc ? 'asc' : ''}` : '';
    const grip = i < defs.length - 1 && !d.fixed ? `<span class="grip" data-col="${i}" title="Drag to resize, double-click to reset"></span>` : '';
    return `<div class="th ${d.num ? 'num' : ''} ${sort}" ${d.sort ? `data-sort="${d.sort}"` : ''}>${d.label}${grip}</div>`;
  }).join('');
}

function originCell(f) {
  return `<div class="muted" title="${esc(f.originDetail || (f.origin ? '' : 'Windows kept no download mark for this file'))}">${esc(f.origin || '—')}</div>`;
}

// ---------- Wide table pieces ----------

const TYPE_LABEL = { installer: 'Installer', archive: 'Archive', document: 'Document', disk: 'Disk image', image: 'Image', video: 'Video', audio: 'Audio', torrent: 'Torrent', other: 'Other' };
const shortDate = (secs) => (secs ? new Date(secs * 1000).toLocaleDateString('sv-SE') : '—');
const dateCell = (secs) => `<div class="muted" title="${esc(secs ? fullDate(secs) + ' · ' + ago(secs) : 'Windows does not say')}">${shortDate(secs)}</div>`;
const typeCell = (f) => `<div class="muted" title="${esc(f.ext ? '.' + f.ext : 'No extension')}">${esc(TYPE_LABEL[f.kind] || f.kind)}${f.ext ? ' · ' + esc(f.ext) : ''}</div>`;
const folderCell = (f) => `<div class="muted cellacts"><span title="${esc(f.dir)}">${esc(f.dir)}</span>${rowActions(f.id)}</div>`;

// The columns of both result tables: the last one says why (old) or what kind of match.
const wideCols = (sortable, last, lastSort) => [
  { label: '<input type="checkbox" class="check" id="allBox" title="Select all shown">', w: 22, fixed: true },
  { label: 'Name', sort: sortable && 'name', w: 240 },
  { label: 'Folder', sort: sortable && 'dir', w: 220 },
  { label: 'Size', sort: sortable && 'size', w: 76, num: true },
  { label: 'Modified', sort: sortable && 'modified', w: 92 },
  { label: 'Created', sort: sortable && 'created', w: 92 },
  { label: 'Type', sort: sortable && 'kind', w: 120 },
  { label: 'From', sort: sortable && 'origin', w: 120 },
  { label: last, sort: sortable && lastSort, w: 200 },
];

// ---------- Old downloads ----------

const OLD_COLS = wideCols(true, 'Why it looks old', 'why');

function oldBase() {
  return S.result.old.map((o) => S.files.get(o.file)).filter((f) => f && !f.kept);
}

const STRONG_FIRST = (x, y) => (x.type === 'untouched' || x.type === 'oldArchive') - (y.type === 'untouched' || y.type === 'oldArchive');

// Ways to group the old-downloads list; each group gets one checkbox for all its files.
const OLD_GROUPS = {
  none: { label: 'Nothing' },
  dir: { label: 'Folder', key: (f) => f.dir },
  origin: { label: 'Where from', key: (f) => originOf(f) },
  kind: { label: 'Type', key: (f) => KIND_LABEL[f.kind] || f.kind },
  ext: { label: 'Extension', key: (f) => extOf(f) },
  reason: { label: 'Main reason', key: (f, o) => REASON[[...o.signals].sort(STRONG_FIRST)[0].type].label },
};

// The old downloads the filters show. On Act the view-only choice "Only selected" is left out.
function oldItems(act) {
  const st = S.old;
  const qt = searchTest(st.f.query);
  const items = S.result.old.filter((o) => {
    const f = S.files.get(o.file);
    if (!f || f.kept) return false;
    if (!act && st.onlySel && !st.sel.has(f.id)) return false;
    if (st.f.reasons.size && !o.signals.some((s) => st.f.reasons.has(s.type))) return false;
    return fileMatches(f, st.f, (x) => x.touched, qt);
  });
  if (act) return items;
  const k = st.sort.key;
  const dir = st.sort.asc ? 1 : -1;
  const val = (o) => {
    const f = S.files.get(o.file);
    return k === 'name' ? f.name.toLowerCase() : k === 'size' ? f.size : k === 'modified' ? f.modified : k === 'created' ? f.created : k === 'kind' ? f.kind : k === 'origin' ? f.origin || '￿' : k === 'dir' ? f.dir.toLowerCase() : o.signals.length;
  };
  items.sort((a, b) => { const x = val(a), y = val(b); return x < y ? -dir : x > y ? dir : 0; });
  return items;
}

// Rows: files, or (when grouped) a header per group followed by its files unless folded.
function oldRows() {
  const st = S.old;
  const items = oldItems();
  st.shownCount = items.length;
  const by = OLD_GROUPS[st.groupBy];
  if (!by || !by.key) return items.map((o) => ({ o, id: o.file }));
  const groups = new Map();
  for (const o of items) {
    const key = by.key(S.files.get(o.file), o);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(o);
  }
  const order = [...groups.entries()].map(([key, os]) => ({ key, os, bytes: os.reduce((a, o) => a + S.files.get(o.file).size, 0) }))
    .sort((a, b) => b.bytes - a.bytes);
  const rows = [];
  for (const g of order) {
    rows.push({ head: g });
    if (!st.folded.has(g.key)) for (const o of g.os) rows.push({ o, id: o.file });
  }
  return rows;
}

const selBytes = (st) => [...st.sel].reduce((a, id) => a + (S.files.get(id)?.size || 0), 0);

function renderOld(main) {
  if (!S.result) return noResult(main, 'Old downloads');
  const st = S.old;
  const F = st.f;
  const r = S.result;
  const total = r.old.reduce((a, o) => a + (S.files.get(o.file)?.size || 0), 0);
  const reasonCounts = {};
  for (const o of r.old) {
    const f = S.files.get(o.file);
    if (!f || f.kept) continue;
    for (const s of o.signals) reasonCounts[s.type] = (reasonCounts[s.type] || 0) + 1;
  }
  const groupOpts = Object.entries(OLD_GROUPS).map(([k, v]) => `<option value="${k}" ${st.groupBy === k ? 'selected' : ''}>${v.label}</option>`).join('');
  const extra = `<button class="btn small popbtn ${F.reasons.size ? 'on' : ''}" id="whyPop">Why it looks old${F.reasons.size ? ` <span class="n">${F.reasons.size}</span>` : ''} ▾</button>
    <button class="chipbtn ${st.onlySel ? 'on' : ''}" id="onlySel" title="Show only what you selected, to look it over before removing">Only selected</button>`;

  main.innerHTML = header('Old downloads', `${nf.format(r.old.length)} files that look like leftovers · ${size(total)}`,
    `<div class="tools"><span class="slide">Group by <select id="groupBy" class="btn small">${groupOpts}</select></span>
      <button class="btn small" id="foldAll" ${st.groupBy === 'none' ? 'hidden' : ''}>Fold all</button><button class="btn small" id="unfoldAll" ${st.groupBy === 'none' ? 'hidden' : ''}>Unfold all</button>
      <button class="btn small" id="recheck" title="Look at the files on disk again and drop what is gone or changed">Re-check files</button></div>`) +
    topbarHtml(F, extra) + `
    <div class="table" id="table">
      <div class="thead">${headCells(OLD_COLS, st)}</div>
      <div class="scroller" id="list" tabindex="0"></div>
    </div>` + selbarHtml(st, '');
  columns($('#table', main), 'old', OLD_COLS);

  let rows = oldRows();
  const scroller = $('#list', main);
  const headState = (g) => {
    const ids = g.os.map((o) => o.file).filter((id) => canSelect(S.files.get(id)));
    const n = ids.filter((id) => st.sel.has(id)).length;
    return { ids, n, all: ids.length > 0 && n === ids.length };
  };
  const rowHtml = (i) => {
    const row = rows[i];
    if (row.head) {
      const g = row.head;
      const hs = headState(g);
      const folded = st.folded.has(g.key);
      return {
        cls: 'group oldhead',
        html: `<div class="ghead"><input type="checkbox" class="check" data-headcheck="${i}" ${hs.all ? 'checked' : ''} ${hs.n && !hs.all ? 'data-mixed="1"' : ''} title="Select or unselect all ${g.os.length} files in this group">
          <button class="linkbtn quiet fold" data-fold="${i}" title="${folded ? 'Unfold' : 'Fold'}">${folded ? '▸' : '▾'}</button>
          <b title="${esc(g.key)}">${esc(g.key)}</b><span>· ${nf.format(g.os.length)} files · ${size(g.bytes)}${hs.n ? ` · ${nf.format(hs.n)} selected` : ''}</span></div><div></div>`,
      };
    }
    const o = row.o;
    const f = S.files.get(o.file);
    const sel = st.sel.has(f.id);
    const lock = isProtected(f) ? '<span class="tag" title="Protected by a path pattern">protected</span>' : '';
    const chips = [...o.signals].sort(STRONG_FIRST).map((s) => `<span class="tag ${s.type === 'untouched' || s.type === 'oldArchive' ? '' : 'accent'}">${esc(REASON[s.type].text(s))}</span>`).join('');
    return {
      cls: `${sel ? 'sel' : ''} ${st.focus === i ? 'focus' : ''}`,
      html: `<div><input type="checkbox" class="check" tabindex="-1" ${sel ? 'checked' : ''} ${canSelect(f) ? '' : 'disabled'}></div>
        <div class="name" title="${esc(f.name)}">${esc(f.name)} ${lock}</div>
        ${folderCell(f)}
        <div class="num">${size(f.size)}</div>
        ${dateCell(f.modified)}${dateCell(f.created)}${typeCell(f)}${originCell(f)}
        <div title="${esc(o.signals.map((s) => REASON[s.type].tip(s)).join('\n'))}">${chips}</div>`,
    };
  };
  const fileIds = () => rows.filter((x) => x.id !== undefined).map((x) => x.id);
  let list = virtualList(scroller, rows.length, rowHtml);
  const markMixed = () => scroller.querySelectorAll('[data-mixed]').forEach((c) => (c.indeterminate = true));
  const redraw = () => { list.redraw(); markMixed(); };
  const counts = () => {
    $('#counts', main).textContent = `${nf.format(st.shownCount)} of ${nf.format(r.old.length)} files shown · ${size(selBytes(st))} selected`;
  };
  const updateSel = wireSelbar(main, st, fileIds, () => { redraw(); updateSel(); updateAll(); counts(); }, () => setStep('act'));
  const updateAll = () => {
    const box = $('#allBox', main);
    const ids = fileIds();
    const n = ids.filter((id) => st.sel.has(id)).length;
    box.checked = ids.length > 0 && n === ids.length;
    box.indeterminate = n > 0 && n < ids.length;
  };
  const changed = () => { updateSel(); updateAll(); counts(); };
  selectionBehaviour(scroller, st, () => rows, (i) => canSelect(S.files.get(rows[i].id)), (i) => rows[i]?.id, { redraw, reveal: (i) => { list.reveal(i); markMixed(); } }, changed, () => setStep('act'));
  wireRowActions(scroller, () => render(), st.f);
  scroller.addEventListener('click', (e) => {
    const hc = e.target.closest('[data-headcheck]');
    const fb = e.target.closest('[data-fold]');
    if (!hc && !fb) return;
    e.stopPropagation();
    if (hc) {
      const hs = headState(rows[Number(hc.dataset.headcheck)].head);
      for (const id of hs.ids) hs.all ? st.sel.delete(id) : st.sel.add(id);
      redraw(); changed();
    } else {
      const key = rows[Number(fb.dataset.fold)].head.key;
      st.folded.has(key) ? st.folded.delete(key) : st.folded.add(key);
      rebuild();
    }
  }, true);
  changed();
  const empty = () => { if (!rows.length) scroller.innerHTML = '<div class="empty"><h2>Nothing here</h2><p>No file matches these filters.</p></div>'; };
  empty();
  markMixed();

  const rebuild = () => { rows = oldRows(); list = virtualList(scroller, rows.length, rowHtml); markMixed(); empty(); changed(); };
  const refilter = () => {
    // Only what passes the filters stays selected, so nothing hidden can go along unseen.
    // Folded groups still count as shown.
    const shownIds = new Set(oldItems().map((o) => o.file));
    for (const id of [...st.sel]) if (!shownIds.has(id)) st.sel.delete(id);
    st.focus = -1;
    st.anchor = -1;
    rebuild();
  };
  wireTopbar(main, F, oldBase, refilter, 'Last used');
  $('#whyPop', main).onclick = (e) => {
    e.stopPropagation();
    const b = e.currentTarget;
    openPanel(b, 300, (pop) => {
      pop.innerHTML = `<div class="popl">${Object.keys(REASON).filter((k) => reasonCounts[k]).map((k) => `<label class="popi"><input type="checkbox" class="check" data-reason="${k}" ${F.reasons.has(k) ? 'checked' : ''}><span class="p">${REASON[k].label}</span><span class="n">${nf.format(reasonCounts[k])}</span></label>`).join('')}</div>
        <div class="popf"><button class="linkbtn quiet" data-none>Clear</button><span class="grow"></span><button class="btn small" data-done>Done</button></div>`;
      pop.querySelectorAll('[data-reason]').forEach((c) => (c.onchange = () => {
        c.checked ? F.reasons.add(c.dataset.reason) : F.reasons.delete(c.dataset.reason);
        b.classList.toggle('on', F.reasons.size > 0);
        b.innerHTML = `Why it looks old${F.reasons.size ? ` <span class="n">${F.reasons.size}</span>` : ''} ▾`;
        $('#clearFilters', main).hidden = !filterActive(F);
        refilter();
      }));
      $('[data-none]', pop).onclick = () => { F.reasons.clear(); pop.querySelectorAll('[data-reason]').forEach((c) => (c.checked = false)); b.classList.remove('on'); b.innerHTML = 'Why it looks old ▾'; $('#clearFilters', main).hidden = !filterActive(F); refilter(); };
      $('[data-done]', pop).onclick = closePopover;
    });
  };
  $('#groupBy', main).onchange = (e) => { st.groupBy = e.target.value; st.folded.clear(); render(); };
  $('#foldAll', main).onclick = () => { for (const x of rows) if (x.head) st.folded.add(x.head.key); rebuild(); };
  $('#unfoldAll', main).onclick = () => { st.folded.clear(); rebuild(); };
  $('#recheck', main).onclick = () => recheckFiles();
  $('#onlySel', main).onclick = (e) => { st.onlySel = !st.onlySel; e.target.closest('button').classList.toggle('on', st.onlySel); rebuild(); };
  main.querySelectorAll('[data-sort]').forEach((h) => (h.onclick = (e) => {
    if (e.target.closest('.grip')) return;
    const k = h.dataset.sort;
    if (st.sort.key === k) st.sort.asc = !st.sort.asc; else st.sort = { key: k, asc: k === 'name' || k === 'dir' || k === 'origin' || k === 'kind' };
    main.querySelectorAll('[data-sort]').forEach((x) => { x.classList.toggle('on', x.dataset.sort === st.sort.key); x.classList.toggle('asc', x.dataset.sort === st.sort.key && st.sort.asc); });
    rebuild();
  }));
  $('#allBox', main).onclick = (e) => {
    const on = e.target.checked;
    for (const id of fileIds()) on && canSelect(S.files.get(id)) ? st.sel.add(id) : st.sel.delete(id);
    redraw(); changed();
  };
}

// Looks at the files on disk again; what is gone or changed drops out of the lists.
async function recheckFiles() {
  await flushState();
  try {
    const p = JSON.parse(await invoke('job_open', { id: S.jobId }));
    applyOpened(S.jobId, p);
    await loadOverview();
    render();
    toast(p.dropped ? `${nf.format(p.dropped)} file${p.dropped === 1 ? ' was' : 's were'} gone or changed since the scan and left out.` : 'Every file is still there, as scanned.');
  } catch (e) { fail(e); }
}

// ---------- Duplicates ----------

const DUP_COLS = wideCols(false, 'Match', null).map((c, i) => (i === 0 ? { label: '', w: 22, fixed: true } : c));

function dupBase() {
  const seen = new Set();
  const out = [];
  for (const g of S.result.groups) for (const id of g.files) if (!seen.has(id) && S.files.has(id)) { seen.add(id); out.push(S.files.get(id)); }
  return out;
}

// ---------- Keep rules ----------

const normDir = (p) => p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
const inFolder = (f, folder) => normDir(f.path).startsWith(normDir(folder) + '\\');
const COPY_MARK = /(\s*[([]\d{1,3}[)\]]|[\s_-]*[([]?(copy|kopie|kopia|copie|copia|kopio|kopya)[)\]]?(\s*[([]?\d{1,3}[)\]]?)?)$/i;
const hasCopyMark = (name) => {
  const stem = name.replace(/\.[^.]+$/, '');
  return COPY_MARK.test(stem) || /^(copy of|kopie van|copie de|kopie von|copia de)\s/i.test(stem);
};

// Each rule scores a file; higher means "rather keep this one". The chain is tried in order,
// the next rule only deciding between files the earlier ones found equal.
const CHAIN_RULES = {
  folderOrder: { label: 'In the folder higher in this job’s list (identical copies only)', score: (f, g) => (g.folderPick === f.id ? 1 : 0) },
  notRemoveFirst: { label: 'Not in a “remove from here first” folder', score: (f) => (pref('removeFirst', []).some((p) => inFolder(f, p)) ? 0 : 1) },
  nomark: { label: 'No copy mark in the name, like (1) or - Copy', score: (f) => (hasCopyMark(f.name) ? 0 : 1) },
  suggested: { label: 'Sift’s pick', score: (f, g) => (f.id === g.suggested ? 1 : 0) },
  newest: { label: 'Newest', score: (f) => f.modified },
  oldest: { label: 'Oldest', score: (f) => -f.modified },
  largest: { label: 'Largest', score: (f) => f.size },
  smallest: { label: 'Smallest', score: (f) => -f.size },
  shortest: { label: 'Shortest name', score: (f) => -f.name.length },
  shortpath: { label: 'Shortest path', score: (f) => -f.path.length },
  origin: { label: 'Has a known download origin', score: (f) => (f.origin ? 1 : 0) },
};
const DEFAULT_CHAIN = ['folderOrder', 'notRemoveFirst', 'nomark', 'suggested'];
const chain = () => pref('keepChain', DEFAULT_CHAIN).map((k) => (k === 'preferred' ? 'folderOrder' : k)).filter((k, i, a) => CHAIN_RULES[k] && a.indexOf(k) === i);

// The file that stays among `ids` (the files of the group that are shown).
function pickByRules(g, rules, ids) {
  let best = ids[0];
  for (const id of ids.slice(1)) {
    for (const k of rules) {
      const a = CHAIN_RULES[k].score(S.files.get(id), g);
      const b = CHAIN_RULES[k].score(S.files.get(best), g);
      if (a !== b) { if (a > b) best = id; break; }
    }
  }
  return best;
}

const QUICK = {
  mine: { label: 'by my rules', rules: () => chain() },
  folderOrder: { label: 'folder order', rules: () => ['folderOrder', 'suggested'] },
  newest: { label: 'newest', rules: () => ['newest'] },
  oldest: { label: 'oldest', rules: () => ['oldest'] },
  largest: { label: 'largest', rules: () => ['largest'] },
  shortest: { label: 'shortest name', rules: () => ['shortest', 'suggested'] },
  shortpath: { label: 'shortest path', rules: () => ['shortpath', 'suggested'] },
  suggested: { label: 'Sift’s pick', rules: () => ['suggested'] },
};

// The files of a group that the filters show. Select actions only ever touch these.
const visOf = (g) => S.dupes.vis.get(g) || g.files.filter((id) => S.files.has(id));

// A group counts as reviewed once you act on it (or press R).
function markReviewed(g, on = true) {
  if (S.reviewed.has(g.key) === on) return;
  on ? S.reviewed.add(g.key) : S.reviewed.delete(g.key);
  queueSave();
  updateBadge(S.jobId);
}

// In each group one of the shown files stays and the other shown files are selected. Kept and
// protected files always stay; when a group has one, nothing else in it needs to stay.
function keepOne(groups, pick) {
  const st = S.dupes;
  for (const g of groups) {
    const ids = visOf(g);
    markReviewed(g);
    const fixed = ids.filter((id) => !canSelect(S.files.get(id)));
    const keepId = fixed.length ? null : pick(g, ids);
    for (const id of ids) {
      if (id === keepId || !canSelect(S.files.get(id))) st.sel.delete(id);
      else st.sel.add(id);
    }
  }
}
const keepAll = (groups) => { for (const g of groups) { markReviewed(g); for (const id of visOf(g)) S.dupes.sel.delete(id); } };

function openRules(onApply) {
  const d = $('#confirm');
  const draw = () => {
    const on = chain();
    const off = Object.keys(CHAIN_RULES).filter((k) => !on.includes(k));
    const folders = (key, title, hint) => {
      const l = pref(key, []);
      return `<div class="rulesec"><b>${title}</b><p class="muted">${hint}</p>
        <div class="list">${l.length ? l.map((p, i) => `<div class="li"><span class="p" title="${esc(p)}">${i + 1}. ${esc(p)}</span>
          <button class="linkbtn quiet" data-fup="${key}:${i}" ${i ? '' : 'disabled'}>↑</button><button class="linkbtn quiet" data-fdel="${key}:${i}">Remove</button></div>`).join('') : '<div class="empty-list">None.</div>'}</div>
        <div class="addrow"><button class="btn small" data-fadd="${key}">Add a folder…</button></div></div>`;
    };
    d.innerHTML = `<div class="dh"><h2>My keep rules</h2><p>Which file stays in a group. Sift tries the rules from the top; the next one only decides when the ones above find files equal. Kept and protected files always stay.</p></div>
      <div class="rules">
        <div class="list">${on.map((k, i) => `<div class="li"><input type="checkbox" class="check" checked data-roff="${k}"><span class="p">${i + 1}. ${esc(CHAIN_RULES[k].label)}</span>
          <button class="linkbtn quiet" data-rup="${i}" ${i ? '' : 'disabled'}>↑</button><button class="linkbtn quiet" data-rdown="${i}" ${i < on.length - 1 ? '' : 'disabled'}>↓</button></div>`).join('')}
          ${off.map((k) => `<div class="li off"><input type="checkbox" class="check" data-ron="${k}"><span class="p">${esc(CHAIN_RULES[k].label)}</span></div>`).join('')}</div>
        <div class="rulesec"><b>Folder order</b><p class="muted">The first rule keeps the copy in the folder that is higher in this job’s folder list (drag folders on the Set up step). It only decides between identical files, and not when they sit in the same folder.</p></div>
        ${folders('removeFirst', 'Remove from here first', 'Copies in these folders are the first to go, like a Downloads or Temp folder.')}
      </div>
      <div class="df"><button class="btn small" id="rReset">Back to the start</button><span class="grow"></span><button class="btn" id="rClose">Close</button><button class="btn primary" id="rApply">Keep by these rules in every group shown</button></div>`;
    const setChain = async (c) => { await savePref('keepChain', c); draw(); };
    d.querySelectorAll('[data-roff]').forEach((c) => (c.onchange = () => setChain(chain().filter((k) => k !== c.dataset.roff))));
    d.querySelectorAll('[data-ron]').forEach((c) => (c.onchange = () => setChain([...chain(), c.dataset.ron])));
    d.querySelectorAll('[data-rup]').forEach((b) => (b.onclick = () => { const c = chain(); const i = Number(b.dataset.rup); [c[i - 1], c[i]] = [c[i], c[i - 1]]; setChain(c); }));
    d.querySelectorAll('[data-rdown]').forEach((b) => (b.onclick = () => { const c = chain(); const i = Number(b.dataset.rdown); [c[i + 1], c[i]] = [c[i], c[i + 1]]; setChain(c); }));
    d.querySelectorAll('[data-fadd]').forEach((b) => (b.onclick = async () => {
      const p = await invoke('pick_folder').catch(fail);
      if (!p) return;
      const l = pref(b.dataset.fadd, []);
      if (!l.includes(p)) l.push(p);
      await savePref(b.dataset.fadd, l);
      draw();
    }));
    d.querySelectorAll('[data-fdel]').forEach((b) => (b.onclick = async () => { const [k, i] = b.dataset.fdel.split(':'); const l = pref(k, []); l.splice(Number(i), 1); await savePref(k, l); draw(); }));
    d.querySelectorAll('[data-fup]').forEach((b) => (b.onclick = async () => { const [k, i] = b.dataset.fup.split(':'); const l = pref(k, []); const n = Number(i); [l[n - 1], l[n]] = [l[n], l[n - 1]]; await savePref(k, l); draw(); }));
    $('#rReset', d).onclick = () => setChain(DEFAULT_CHAIN);
    $('#rClose', d).onclick = () => d.close();
    $('#rApply', d).onclick = () => { d.close(); onApply(); };
  };
  draw();
  if (!d.open) d.showModal();
}

// ---------- Duplicates list ----------

// A group shows when at least one of its files passes the filters (and, when searching, one of
// those matches the search); then the files that pass are shown. On Act the choices that only
// shape the Results view (which kinds, which show-state) are left out: the levels there say it.
function groupsShown(act) {
  const st = S.dupes;
  const F = st.f;
  const qt = searchTest(F.query);
  st.vis = new Map();
  let out = S.result.groups.filter((g) => {
    if (!act && (st.kinds.size ? !st.kinds.has(g.kind) : !(GROUP[g.kind].main || st.notSure))) return false;
    if (S.ignored.has(g.key) && !(st.showDismissed && !act)) return false;
    if (g.files.filter((id) => S.files.has(id)).length < 2) return false;
    const ok = g.files.map((id) => S.files.get(id)).filter((f) => f && fileMatches(f, F, (x) => x.modified, null));
    if (!ok.length) return false;
    if (qt && !ok.some((f) => qt(f.path))) return false;
    if (!act && st.hideSingles && ok.length < 2) return false;
    const ids = ok.map((f) => f.id);
    if (!act) {
      const nSel = ids.filter((id) => st.sel.has(id)).length;
      if (st.show === 'undecided' && nSel) return false;
      if (st.show === 'selected' && !nSel) return false;
      if (st.show === 'multiKept' && !(nSel && ids.length - nSel >= 2)) return false;
      if (st.show === 'allKept' && !(!nSel && S.reviewed.has(g.key))) return false;
    }
    st.vis.set(g, ids);
    return true;
  });
  if (act) return out;
  const by = st.gsort;
  if (by === 'freed') out = out.slice().sort((a, b) => freeable(b) - freeable(a));
  else if (by === 'count') out = out.slice().sort((a, b) => b.files.length - a.files.length);
  else if (by === 'name') out = out.slice().sort((a, b) => a.label.localeCompare(b.label));
  return out;
}

function freeable(g) {
  return g.files.reduce((a, id) => a + (id === g.suggested ? 0 : S.files.get(id)?.size || 0), 0);
}

const SHOW_STATES = [['all', 'All groups'], ['undecided', 'Nothing selected yet'], ['selected', 'Something selected'], ['multiKept', 'More than one file kept'], ['allKept', 'Everything kept (looked at, none selected)']];

function renderDupes(main) {
  if (!S.result) return noResult(main, 'Duplicates');
  const st = S.dupes;
  const F = st.f;
  const r = S.result;
  const counts = {};
  for (const g of r.groups) counts[g.kind] = (counts[g.kind] || 0) + 1;
  const mainCount = r.groups.filter((g) => GROUP[g.kind].main).length;
  const notSureCount = r.groups.length - mainCount;
  const totalFree = r.groups.filter((g) => g.kind === 'copies').reduce((a, g) => a + freeable(g), 0);
  const viewOn = () => st.show !== 'all' || st.hideSingles || st.showDismissed;
  const extra = `<button class="btn small popbtn ${st.kinds.size || st.notSure ? 'on' : ''}" id="certPop">Certainty ▾</button>
    <button class="btn small popbtn ${viewOn() ? 'on' : ''}" id="viewPop">Groups ▾</button>`;
  const sortOpts = [['kind', 'kind'], ['freed', 'space freed'], ['count', 'number of files'], ['name', 'name']].map(([k, l]) => `<option value="${k}" ${st.gsort === k ? 'selected' : ''}>${l}</option>`).join('');

  main.innerHTML = header('Duplicates', `${nf.format(mainCount)} groups of duplicates · the extra copies take ${size(totalFree)}` + (notSureCount ? ` · ${nf.format(notSureCount)} more groups not sure` : ''),
    `<div class="tools"><span class="slide">Sort groups by <select id="gsort" class="btn small">${sortOpts}</select></span>
      <button class="btn small" id="recheck" title="Look at the files on disk again and drop what is gone or changed">Re-check files</button></div>`) +
    topbarHtml(F, extra) +
    `<div class="globalkeep"><span class="muted">In every group shown, keep</span>
      <button class="btn small primary" data-allrule="mine" title="${esc(chain().map((k, i) => i + 1 + '. ' + CHAIN_RULES[k].label).join('\n'))}">by my rules</button>
      <button class="btn small" id="editRules">Rules…</button>
      ${Object.entries(QUICK).filter(([k]) => k !== 'mine' && k !== 'suggested').map(([k, v]) => `<button class="btn small" data-allrule="${k}">${esc(v.label)}</button>`).join('')}
      <button class="btn small" id="keepAllShown" title="Unselect every shown file in the groups shown">keep all</button>
      <span class="chipsep"></span>
      <button class="btn small" id="acceptSure" title="In every sure group (copies, versions) keep the file Sift would keep">Accept Sift’s pick in sure groups</button>
      <button class="btn small" id="keepMatching" title="Keep the files matching the search, select the other shown files of those groups">Keep matching</button>
      <button class="btn small" id="removeMatching" title="Select the files matching the search; never every file of a group">Remove matching</button>
      <button class="btn small" id="ignoreShown" title="Hide the groups shown for this job. They can be brought back from Groups ▾.">Ignore shown groups</button>
      <button class="btn small" id="nextUnrev" title="Jump to the next group not looked at (N)">Next unreviewed</button>
      <span class="grow"></span><button class="linkbtn" id="keysBtn">Keys</button></div>
    <div class="keyhelp" id="keyhelp" ${st.keys ? '' : 'hidden'}>↑ ↓ move · Space tick · J / K next or previous group · N next group not reviewed · R mark reviewed · 1–9 keep that file, tick the others · A keep by my rules · U keep all in group · I not duplicates · Delete go to Act</div>
    <div class="table" id="table">
      <div class="thead">${headCells(DUP_COLS, st)}</div>
      <div class="scroller" id="list" tabindex="0"></div>
    </div>` + selbarHtml(st, '');
  columns($('#table', main), 'dupes', DUP_COLS);

  let groups = [];
  let rows = [];
  const owner = new Map();
  const build = () => {
    groups = groupsShown();
    rows = [];
    owner.clear();
    for (const g of groups) {
      rows.push({ g });
      let n = 0;
      for (const id of visOf(g)) { rows.push({ g, id, n: ++n }); owner.set(id, g); }
    }
  };
  build();
  st.onTouch = (id) => { const g = owner.get(id); if (g) markReviewed(g); };
  const scroller = $('#list', main);
  const rowHtml = (i) => {
    const row = rows[i];
    const g = row.g;
    if (row.id === undefined) {
      const ids = visOf(g);
      const sizes = new Set(ids.map((id) => S.files.get(id)?.size));
      const each = sizes.size === 1 ? `${size([...sizes][0])} each` : 'different sizes';
      const nSel = ids.filter((id) => st.sel.has(id)).length;
      const tip = g.fingerprint ? `Compared byte for byte: identical.\nFingerprint (MD5): ${g.fingerprint}` : GROUP[g.kind].tip;
      const isDismissed = st.showDismissed && S.ignored.has(g.key);
      const rev = S.reviewed.has(g.key);
      return {
        cls: 'group',
        html: `<div title="${esc(tip)}"><b>${esc(GROUP[g.kind].label)}</b> · ${esc(g.label)} · ${ids.length}${ids.length < g.files.length ? ' of ' + g.files.length : ''} files · ${each}${nSel ? ` · <span class="accentText">${nSel} selected</span>` : ''}${rev ? ' <span class="tag accent" title="You looked at this group">reviewed ✓</span>' : ''}</div>
          <div class="acts">Keep: <button class="linkbtn" data-rule="mine" data-g="${i}">my rules</button><button class="linkbtn" data-rule="newest" data-g="${i}">newest</button><button class="linkbtn" data-rule="oldest" data-g="${i}">oldest</button><button class="linkbtn" data-rule="largest" data-g="${i}">largest</button><button class="linkbtn" data-rule="all" data-g="${i}">all</button>
          <button class="linkbtn quiet" data-review="${i}" title="${rev ? 'Take the reviewed mark off (R)' : 'Mark as looked at (R)'}">${rev ? 'Not reviewed' : 'Reviewed'}</button>
          <button class="linkbtn quiet" data-dismiss="${i}" title="${isDismissed ? 'Show this group as duplicates again' : 'Hide this group: these are not duplicates (remembered)'}">${isDismissed ? 'Duplicates after all' : 'Not duplicates'}</button></div>`,
      };
    }
    const f = S.files.get(row.id);
    const sel = st.sel.has(f.id);
    const stays = !sel && g.files.some((id) => st.sel.has(id));
    const tags = (f.kept ? '<span class="tag">kept</span>' : '') + (!f.kept && isProtected(f) ? '<span class="tag" title="Protected by a path pattern">protected</span>' : '') + (row.id === g.suggested && !f.kept ? `<span class="tag accent" title="The one Sift would keep">Sift’s pick</span>` : '');
    return {
      cls: `member ${sel ? 'sel' : ''} ${stays ? 'stays' : ''} ${st.focus === i ? 'focus' : ''}`,
      html: `<div><input type="checkbox" class="check" tabindex="-1" ${sel ? 'checked' : ''} ${canSelect(f) ? '' : 'disabled'}></div>
        <div class="name" title="${esc(f.name)}${stays ? '\nThis one stays' : ''}">${row.n <= 9 && st.focus >= 0 && rows[st.focus]?.g === g ? `<span class="keynum">${row.n}</span>` : ''}${esc(f.name)} ${tags}</div>
        ${folderCell(f)}
        <div class="num">${size(f.size)}</div>
        ${dateCell(f.modified)}${dateCell(f.created)}${typeCell(f)}${originCell(f)}
        <div class="muted" title="${esc(GROUP[g.kind].tip)}">${esc(GROUP[g.kind].label)}</div>`,
    };
  };
  let list = virtualList(scroller, rows.length, rowHtml);
  const visibleIds = () => rows.filter((x) => x.id !== undefined).map((x) => x.id);
  const decided = () => {
    const d = groups.filter((g) => visOf(g).some((id) => st.sel.has(id))).length;
    $('#decided', main).textContent = groups.length ? `${nf.format(d)} of ${nf.format(groups.length)} groups have a selection` : '';
  };
  const countsText = () => {
    $('#counts', main).textContent = `${nf.format(groups.length)} of ${nf.format(r.groups.length)} groups shown · ${size(selBytes(st))} selected · ${nf.format(S.reviewed.size)} reviewed`;
  };
  const updateSelBase = wireSelbar(main, st, visibleIds, () => { list.redraw(); updateSel(); }, () => setStep('act'));
  const updateSel = () => { updateSelBase(); countsText(); };
  selectionBehaviour(scroller, st, () => rows, (i) => rows[i].id !== undefined && canSelect(S.files.get(rows[i].id)), (i) => rows[i]?.id, { redraw: () => list.redraw(), reveal: (i) => list.reveal(i) }, updateSel, () => setStep('act'));
  wireRowActions(scroller, () => render(), st.f);
  const applyQuick = (gs, rule) => {
    if (rule === 'all') keepAll(gs);
    else { const rules = QUICK[rule].rules(); keepOne(gs, (g, ids) => pickByRules(g, rules, ids)); }
  };
  const toggleDismiss = async (g) => {
    const had = S.ignored.has(g.key);
    if (had) S.ignored.delete(g.key); else { S.ignored.add(g.key); for (const id of g.files) st.sel.delete(id); }
    queueSave();
    return !had;
  };
  scroller.addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-rule]');
    const dm = e.target.closest('button[data-dismiss]');
    const rv = e.target.closest('button[data-review]');
    if (!b && !dm && !rv) return;
    e.stopPropagation();
    if (b) {
      applyQuick([rows[Number(b.dataset.g)].g], b.dataset.rule);
      list.redraw(); updateSel();
    } else if (rv) {
      const g = rows[Number(rv.dataset.review)].g;
      markReviewed(g, !S.reviewed.has(g.key));
      list.redraw(); updateSel();
    } else {
      const hid = await toggleDismiss(rows[Number(dm.dataset.dismiss)].g);
      if (hid) toast('Hidden as not duplicates. “Groups” in the bar brings them back.');
      render();
    }
  });
  // Jump to the first file of the next group not looked at, after the focused one (wrapping).
  const nextUnreviewed = () => {
    const cur = rows[st.focus];
    const gi = cur ? groups.indexOf(cur.g) : -1;
    for (let k = 1; k <= groups.length; k++) {
      const g = groups[(gi + k) % groups.length];
      if (!S.reviewed.has(g.key)) {
        const i = rows.findIndex((x) => x.g === g && x.id !== undefined);
        if (i >= 0) { st.focus = i; st.anchor = i; list.reveal(i); scroller.focus({ preventScroll: true }); return; }
      }
    }
    toast('Every group shown has been looked at.');
  };
  // Keyboard review on top of the arrows and Space from selectionBehaviour.
  scroller.addEventListener('keydown', async (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const cur = rows[st.focus];
    const k = e.key.toLowerCase();
    const jump = (d) => {
      const g0 = cur ? cur.g : null;
      let i = st.focus < 0 ? (d > 0 ? -1 : rows.length) : st.focus;
      do { i += d; } while (i >= 0 && i < rows.length && (rows[i].id === undefined || rows[i].g === g0));
      if (i < 0 || i >= rows.length) return;
      // Land on the first file of that group.
      while (i > 0 && rows[i - 1].id !== undefined && rows[i - 1].g === rows[i].g) i--;
      st.focus = i;
      st.anchor = i;
      list.reveal(i);
    };
    if (k === 'j') { e.preventDefault(); jump(1); }
    else if (k === 'k') { e.preventDefault(); jump(-1); }
    else if (k === 'n') { e.preventDefault(); nextUnreviewed(); }
    else if (cur && k === 'r') { markReviewed(cur.g, !S.reviewed.has(cur.g.key)); list.redraw(); updateSel(); }
    else if (cur && /^[1-9]$/.test(k)) {
      const target = rows.find((x) => x.g === cur.g && x.n === Number(k));
      if (target) { keepOne([cur.g], () => target.id); list.redraw(); updateSel(); }
    } else if (cur && k === 'a') { applyQuick([cur.g], 'mine'); list.redraw(); updateSel(); }
    else if (cur && k === 'u') { keepAll([cur.g]); list.redraw(); updateSel(); }
    else if (cur && k === 'i') { await toggleDismiss(cur.g); render(); }
  });
  updateSel();
  const empty = () => { if (!rows.length) scroller.innerHTML = '<div class="empty"><h2>Nothing here</h2><p>No group matches these filters.</p></div>'; };
  empty();

  const refilter = () => {
    build();
    const shownIds = new Set(visibleIds());
    for (const id of [...st.sel]) if (!shownIds.has(id) && st.show !== 'undecided') st.sel.delete(id);
    st.focus = -1;
    st.anchor = -1;
    list = virtualList(scroller, rows.length, rowHtml);
    empty();
    updateSel();
  };
  wireTopbar(main, F, dupBase, refilter, 'Changed');

  // Which kinds of group, and the ways to look at the groups.
  const kindPanel = (b) => openPanel(b, 340, (pop) => {
    const mainKinds = Object.keys(GROUP).filter((k) => GROUP[k].main);
    const sureKinds = Object.keys(GROUP).filter((k) => !GROUP[k].main);
    const row = (k) => `<label class="popi" title="${esc(GROUP[k].tip)}"><input type="checkbox" class="check" data-gkind="${k}" ${st.kinds.has(k) ? 'checked' : ''}><span class="p">${GROUP[k].label}</span><span class="n">${nf.format(counts[k] || 0)}</span></label>`;
    pop.innerHTML = `<div class="popl"><div class="pophead">Duplicates</div>${mainKinds.map(row).join('')}<div class="pophead">Not sure</div>${sureKinds.map(row).join('')}
      <label class="popi"><input type="checkbox" class="check" id="notSure" ${st.notSure ? 'checked' : ''}><span class="p">Show the not sure groups</span><span class="n">${nf.format(notSureCount)}</span></label></div>
      <div class="popf"><button class="linkbtn quiet" data-none>Clear</button><span class="grow"></span><button class="btn small" data-done>Done</button></div>`;
    const sync = () => { b.classList.toggle('on', st.kinds.size > 0 || st.notSure); refilter(); };
    pop.querySelectorAll('[data-gkind]').forEach((c) => (c.onchange = () => { c.checked ? st.kinds.add(c.dataset.gkind) : st.kinds.delete(c.dataset.gkind); sync(); }));
    $('#notSure', pop).onchange = (e) => {
      st.notSure = e.target.checked;
      if (!st.notSure) for (const k of Object.keys(GROUP)) if (!GROUP[k].main) st.kinds.delete(k);
      kindPanel(b);
      sync();
    };
    $('[data-none]', pop).onclick = () => { st.kinds.clear(); st.notSure = false; kindPanel(b); sync(); };
    $('[data-done]', pop).onclick = closePopover;
  });
  $('#certPop', main).onclick = (e) => { e.stopPropagation(); kindPanel(e.currentTarget); };
  const viewPanel = (b) => openPanel(b, 420, (pop) => {
    const ign = r.groups.filter((g) => S.ignored.has(g.key));
    pop.innerHTML = `<div class="popl"><div class="pophead">Show</div>
      ${SHOW_STATES.map(([k, l]) => `<label class="popi"><input type="radio" name="show" class="check radio" value="${k}" ${st.show === k ? 'checked' : ''}><span class="p">${l}</span></label>`).join('')}
      <div class="pophead">More</div>
      <label class="popi"><input type="checkbox" class="check" id="hideSingles" ${st.hideSingles ? 'checked' : ''}><span class="p">Hide groups left with one file</span></label>
      <label class="popi"><input type="checkbox" class="check" id="showIgn" ${st.showDismissed ? 'checked' : ''}><span class="p">Show the groups I ignored</span><span class="n">${ign.length}</span></label>
      ${ign.length ? `<div class="pophead">Ignored groups <button class="linkbtn" id="unignoreAll">Bring all back</button></div>${ign.slice(0, 50).map((g, i) => `<div class="popi"><span class="p" title="${esc(g.label)}">${esc(GROUP[g.kind].label)} · ${esc(g.label)}</span><button class="linkbtn" data-unign="${i}">Bring back</button></div>`).join('')}${ign.length > 50 ? `<div class="empty-list">and ${ign.length - 50} more</div>` : ''}` : ''}</div>
      <div class="popf"><span class="grow"></span><button class="btn small" data-done>Done</button></div>`;
    const sync = () => { b.classList.toggle('on', viewOn()); refilter(); };
    pop.querySelectorAll('[name=show]').forEach((c) => (c.onchange = () => { st.show = c.value; sync(); }));
    $('#hideSingles', pop).onchange = (e) => { st.hideSingles = e.target.checked; sync(); };
    $('#showIgn', pop).onchange = (e) => { st.showDismissed = e.target.checked; sync(); };
    pop.querySelectorAll('[data-unign]').forEach((c) => (c.onclick = () => { S.ignored.delete(ign[Number(c.dataset.unign)].key); queueSave(); viewPanel(b); sync(); }));
    const ua = $('#unignoreAll', pop);
    if (ua) ua.onclick = () => { for (const g of ign) S.ignored.delete(g.key); queueSave(); viewPanel(b); sync(); };
    $('[data-done]', pop).onclick = closePopover;
  });
  $('#viewPop', main).onclick = (e) => { e.stopPropagation(); viewPanel(e.currentTarget); };

  $('#gsort', main).onchange = (e) => { st.gsort = e.target.value; refilter(); };
  $('#recheck', main).onclick = () => recheckFiles();
  $('#editRules', main).onclick = () => openRules(() => { applyQuick(groups, 'mine'); render(); toast(`Kept one file by your rules in ${nf.format(groups.length)} groups; the rest is selected.`); });
  $('#keysBtn', main).onclick = () => { st.keys = !st.keys; $('#keyhelp', main).hidden = !st.keys; scroller.focus(); };
  main.querySelectorAll('[data-allrule]').forEach((b) => (b.onclick = () => {
    applyQuick(groups, b.dataset.allrule);
    list.redraw(); updateSel();
    toast(`In ${nf.format(groups.length)} groups one shown file stays (${esc(QUICK[b.dataset.allrule].label)}); the other shown files are selected.`);
  }));
  $('#keepAllShown', main).onclick = () => { keepAll(groups); list.redraw(); updateSel(); };
  $('#acceptSure', main).onclick = () => {
    const sure = groups.filter((g) => GROUP[g.kind].main);
    keepOne(sure, (g, ids) => pickByRules(g, ['suggested'], ids));
    list.redraw(); updateSel();
    toast(`Sift’s pick stays in ${nf.format(sure.length)} sure group${sure.length === 1 ? '' : 's'}; the other shown files are selected.`);
  };
  const byQuery = (keepThem) => {
    const qt = searchTest(F.query);
    if (!qt) { toast('Type something in the search box first.'); return; }
    let done = 0, skipped = 0;
    for (const g of groups) {
      const ids = visOf(g);
      const hit = ids.filter((id) => qt(S.files.get(id).path));
      if (!hit.length) continue;
      if (!keepThem && hit.length === ids.length) { skipped++; continue; }
      markReviewed(g);
      for (const id of ids) {
        const f = S.files.get(id);
        if (!canSelect(f)) continue;
        const matches = hit.includes(id);
        if (keepThem) matches ? st.sel.delete(id) : st.sel.add(id);
        else if (matches) st.sel.add(id);
      }
      done++;
    }
    list.redraw(); updateSel();
    toast(`${keepThem ? 'Kept the matching files' : 'Selected the matching files'} in ${nf.format(done)} group${done === 1 ? '' : 's'}.${skipped ? ` ${skipped} left alone: every file in them matches.` : ''}`);
  };
  $('#keepMatching', main).onclick = () => byQuery(true);
  $('#removeMatching', main).onclick = () => byQuery(false);
  $('#ignoreShown', main).onclick = () => {
    const gs = groups.filter((g) => !S.ignored.has(g.key));
    if (!gs.length) return;
    for (const g of gs) { S.ignored.add(g.key); for (const id of g.files) st.sel.delete(id); }
    queueSave();
    render();
    toast(`${nf.format(gs.length)} group${gs.length === 1 ? '' : 's'} ignored for this job.`, { label: 'Undo', run: () => { for (const g of gs) S.ignored.delete(g.key); queueSave(); render(); } });
  };
  $('#nextUnrev', main).onclick = () => nextUnreviewed();
}

// ---------- Set up ----------

const deepEq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const allPresets = () => [...S.overview.presets, ...S.overview.userPresets];
const valuesOf = (j) => ({ findOld: j.findOld, findDupes: j.findDupes, settings: j.settings });
const clone = (x) => JSON.parse(JSON.stringify(x));

function presetStatus(j) {
  const p = allPresets().find((x) => x.id === j.preset);
  if (!p) return { name: 'No preset', changed: false, p: null };
  return { name: p.name, changed: !deepEq(valuesOf(j), { findOld: p.findOld, findDupes: p.findDupes, settings: p.settings }), p };
}

const MIN_STEPS = [0, 1024, 10240, 102400, 1 << 20, 10 << 20, 100 << 20];
const MAX_STEPS = [0, 1 << 20, 10 << 20, 100 << 20, 1 << 30, 10 * 2 ** 30];
const nearest = (steps, v) => steps.reduce((bi, s, i) => (Math.abs(s - v) < Math.abs(steps[bi] - v) ? i : bi), 0);
const months = (v) => `${v} month${v === 1 ? '' : 's'}`;

// The sliders of a job. `toUi` and `fromUi` map the setting to the slider position and back.
const SLIDERS = [
  { sec: 'old', key: 'untouchedMonths', title: 'Unused for at least', desc: 'A file nobody opened or changed for this long counts as old.', min: 1, max: 36, toUi: (v) => v, fromUi: (u) => u, label: months },
  { sec: 'old', key: 'archiveMonths', title: 'Archives older than', desc: 'Zip, 7z and rar files older than this count as old, even if opened lately.', min: 1, max: 24, toUi: (v) => v, fromUi: (u) => u, label: months },
  { sec: 'dupes', key: 'minSize', title: 'Leave out files smaller than', desc: 'Tiny files are rarely worth the time.', min: 0, max: MIN_STEPS.length - 1, toUi: (v) => nearest(MIN_STEPS, v), fromUi: (u) => MIN_STEPS[u], label: (v) => (v ? size(v) : 'Include all') },
  { sec: 'dupes', key: 'similar', title: 'Similar names: how alike', desc: 'How close two names must be to show as “similar names”. Lower finds more, and more that are not really the same.', min: 79, max: 99, toUi: (v) => (v ? v : 79), fromUi: (u) => (u === 79 ? 0 : u), label: (v) => (v ? v + '%' : 'Off') },
  { sec: 'files', key: 'maxSize', title: 'Leave out files larger than', desc: 'Skips very big files, like disk images, for both lists.', min: 0, max: MAX_STEPS.length - 1, toUi: (v) => nearest(MAX_STEPS, v), fromUi: (u) => MAX_STEPS[u], label: (v) => (v ? size(v) : 'No limit') },
];

const sliderRow = (it, v) => `<div class="setting"><div class="t">${it.title}</div><div class="d">${it.desc}</div>
  <div class="ctl"><input type="range" data-key="${it.key}" min="${it.min}" max="${it.max}" value="${it.toUi(v)}" aria-label="${esc(it.title)}"><output>${esc(it.label(v))}</output></div></div>`;

const toDateStr = (secs) => (secs ? new Date(secs * 1000).toLocaleDateString('sv-SE') : '');
const fromDateStr = (s, end) => (s ? Math.floor(new Date(s + (end ? 'T23:59:59' : 'T00:00:00')).getTime() / 1000) : null);

function settingsHtml(j) {
  const st = j.settings;
  const sec = (title, rows) => `<div class="setsec"><h3>${title}</h3>${rows}</div>`;
  const sl = (s) => SLIDERS.filter((x) => x.sec === s).map((it) => sliderRow(it, st[it.key])).join('');
  const kinds = Object.keys(GROUP).map((k) => `<label class="tgl" title="${esc(GROUP[k].tip)}"><input type="checkbox" class="check" data-kind="${k}" ${st.kinds[k] ? 'checked' : ''}>${GROUP[k].label}</label>`).join('');
  return (j.findOld ? sec('Old downloads', sl('old')) : '') +
    (j.findDupes ? sec('Duplicates', sl('dupes') + `<div class="setting"><div class="t">Kinds to look for</div><div class="d">Which groups of duplicates to find. Copies and versions are the sure ones.</div><div class="ctl kinds">${kinds}</div></div>`) : '') +
    sec('Which files', sl('files') + `
      <div class="setting"><div class="t">Only files dated</div><div class="d">Leave empty for any date. Looks at the date modified or created.</div>
        <div class="ctl dates"><select data-set="dateBy" class="btn small" aria-label="Date to use"><option value="modified" ${st.dateBy === 'modified' ? 'selected' : ''}>Modified</option><option value="created" ${st.dateBy === 'created' ? 'selected' : ''}>Created</option></select>
          <input type="date" data-date="dateFrom" value="${toDateStr(st.dateFrom)}" aria-label="From"><span>to</span><input type="date" data-date="dateTo" value="${toDateStr(st.dateTo)}" aria-label="To"></div></div>
      <div class="setting"><div class="t">Only these extensions</div><div class="d">Like <b>zip, 7z, exe</b>. Empty means all files.</div>
        <div class="ctl"><input type="text" id="exts" class="txt" placeholder="All extensions" value="${esc(st.extensions.join(', '))}"></div></div>
      <div class="setting"><div class="t">Skip Windows system folders</div><div class="d">Leaves out Windows, Program Files, ProgramData and the Recycle Bin at a drive root.</div>
        <div class="ctl"><label class="tgl"><input type="checkbox" class="check" data-set="skipSystem" ${st.skipSystem ? 'checked' : ''}>Skip them</label></div></div>`);
}

function folderRowsHtml(j) {
  let n = 0;
  return j.folders.length ? j.folders.map((f, i) => `<div class="li frow ${f.active ? '' : 'off'}" draggable="true" data-i="${i}">
      <span class="grab" title="Drag to change the order" aria-hidden="true">⋮⋮</span>
      <input type="checkbox" class="check" data-act="${i}" ${f.active ? 'checked' : ''} title="Look in this folder" aria-label="Look in ${esc(f.path)}">
      <span class="rank" title="Place in this job’s order">${f.active ? ++n : ''}</span>
      <span class="p" title="${esc(f.path)}">${esc(f.path)}</span>
      <label class="tgl small" title="Also look in the folders inside it"><input type="checkbox" class="check" data-rec="${i}" ${f.recursive ? 'checked' : ''}>Subfolders</label>
      <button class="linkbtn quiet" data-up="${i}" ${i ? '' : 'disabled'} title="Move up" aria-label="Move up">↑</button><button class="linkbtn quiet" data-down="${i}" ${i < j.folders.length - 1 ? '' : 'disabled'} title="Move down" aria-label="Move down">↓</button>
      <button class="linkbtn quiet" data-showf="${i}">Show</button><button class="linkbtn quiet" data-rm="${i}" title="Forget this folder in every job">Remove</button></div>`).join('')
    : '<div class="empty-list">No folders yet. Add one below.</div>';
}

function presetBarHtml(j) {
  const ps = allPresets();
  const opt = (p) => `<option value="${esc(p.id)}" ${p.id === j.preset ? 'selected' : ''}>${esc(p.name)}</option>`;
  const own = j.preset && String(j.preset).startsWith('u');
  return `<div class="presetrow">
    <select id="preset" class="btn" aria-label="Preset"><option value="" ${ps.some((p) => p.id === j.preset) ? '' : 'selected'}>No preset</option>
      <optgroup label="Built in">${S.overview.presets.map(opt).join('')}</optgroup>
      ${S.overview.userPresets.length ? `<optgroup label="Mine">${S.overview.userPresets.map(opt).join('')}</optgroup>` : ''}</select>
    <span id="presetState" class="presetstate"></span><button class="linkbtn" id="backPreset" hidden>Back to preset</button>
    <span class="grow"></span>
    ${own ? '<button class="btn small" id="renamePreset">Rename</button><button class="btn small" id="deletePreset">Delete</button>' : ''}
    <button class="btn small" id="savePreset">Save as preset…</button></div>
    <p class="hint" id="presetDesc"></p>`;
}

function updatePresetState() {
  const j = job();
  const ps = presetStatus(j);
  const el = $('#presetState');
  if (!el) return;
  el.innerHTML = ps.p ? `<b>${esc(ps.name)}</b>${ps.changed ? ' <span class="tag warn">changed</span>' : ''}` : '<span class="muted">Settings are your own</span>';
  $('#backPreset').hidden = !ps.changed;
  $('#presetDesc').textContent = ps.p ? (ps.p.description || '') : 'A preset fills in what to find and every setting below. It never holds folders.';
}

function scanAreaHtml() {
  const j = job();
  const r = rtOf(j.id);
  const active = j.folders.filter((f) => f.active).length;
  if (r.scanning) {
    const pct = pctOf(r.progress);
    return `<div class="scanrow"><div class="scaninfo">${esc(progressText(r.progress))}</div><button class="btn" id="stopScan">Stop</button></div>
      <div class="bar ${pct == null ? 'busy' : ''}"><i style="width:${pct == null ? '' : pct + '%'}"></i></div>`;
  }
  const res = r.result;
  const last = res ? `Last scan ${ago(res.finishedAt)} · ${nf.format(res.old.length)} old files · ${nf.format(res.groups.filter((g) => GROUP[g.kind].main).length)} groups of duplicates` : 'Not scanned yet';
  return `<div class="scanrow"><button class="btn primary big" id="scanBtn" ${active ? '' : 'disabled'}>${res ? 'Scan again' : 'Scan'}</button>
    <div class="scaninfo" title="${res ? esc(fullDate(res.finishedAt)) : ''}">${active ? esc(last) : 'Tick at least one folder above.'}</div>
    ${res ? '<button class="linkbtn" id="toResults">Go to Results ›</button>' : ''}</div>`;
}

function updateScanArea() {
  const el = $('#scanArea');
  if (!el || S.view !== 'job' || job().step !== 'setup') return;
  const j = job();
  const r = rtOf(j.id);
  // While scanning only the text and bar move, so the Stop button keeps its hover.
  const bar = el.querySelector('.bar');
  if (r.scanning && bar && el.querySelector('#stopScan')) {
    const pct = pctOf(r.progress);
    el.querySelector('.scaninfo').textContent = progressText(r.progress);
    bar.classList.toggle('busy', pct == null);
    bar.firstElementChild.style.width = pct == null ? '' : pct + '%';
    return;
  }
  el.innerHTML = scanAreaHtml();
  wireScanArea(el);
}

function wireScanArea(el) {
  const j = job();
  const b = $('#scanBtn', el);
  if (b) b.onclick = () => scanJob(j.id);
  const s = $('#stopScan', el);
  if (s) s.onclick = () => stopScan(j.id);
  const t = $('#toResults', el);
  if (t) t.onclick = () => setStep('results');
}

async function refreshPicks() {
  if (!S.result) return;
  try {
    const picks = await invoke('job_picks', { id: S.jobId });
    S.result.groups.forEach((g, i) => { g.folderPick = picks[i] ?? null; });
  } catch (e) { /* the picks stay as they were */ }
}

async function afterFolderChange(j) {
  await saveJob(j);
  refreshPicks();
}

async function reloadFolders() {
  await loadOverview(true);
  render();
}

function renderSetup(main) {
  const j = job();
  main.innerHTML = `<div class="head"><div class="namebox"><label class="muted" for="jobName">Job name</label><input id="jobName" class="nameinput" value="${esc(j.name)}" maxlength="60"></div><div class="grow"></div>
      <div class="tools"><button class="btn small" id="dupJob">Duplicate job</button><button class="btn small" id="delJob">Delete job</button></div></div>
    <div class="page">
      <section class="card"><h2><span class="stepn">1</span>Folders</h2>
        <p class="hint">Tick the folders this job looks in. When identical copies sit in different folders, the one in the folder higher in this list stays.</p>
        <div class="list" id="flist">${folderRowsHtml(j)}</div>
        <div class="addrow"><button class="btn primary" id="addFolder">Add a folder…</button><button class="btn" id="pasteBtn">Paste paths…</button></div>
        <div id="pastebox" class="pastebox" hidden><textarea id="pasteIn" rows="3" placeholder="One path per line, or separated by ;"></textarea><button class="btn" id="pasteAdd">Add these</button></div>
        <details class="skipbox"><summary>Skip: folders and patterns Sift never goes into (${S.overview.skip.length})</summary>
          <p class="hint">The same for every job. Use * for anything, like <b>*\\Steam\\*</b> or <b>*.tmp</b>.</p>
          <div class="list">${S.overview.skip.length ? S.overview.skip.map((p, i) => `<div class="li"><span class="p">${esc(p)}</span><button class="linkbtn quiet" data-unskip="${i}">Remove</button></div>`).join('') : '<div class="empty-list">Nothing skipped.</div>'}</div>
          <div class="addrow"><input id="skipIn" placeholder="A folder path or a pattern"><button class="btn" id="addSkip">Add</button></div></details>
      </section>

      <section class="card"><h2><span class="stepn">2</span>What to find</h2>
        <div class="finds"><label class="tgl big"><input type="checkbox" class="check" data-find="findOld" ${j.findOld ? 'checked' : ''}>Old downloads<small>Unused, installed already, unpacked, replaced by a newer version</small></label>
          <label class="tgl big"><input type="checkbox" class="check" data-find="findDupes" ${j.findDupes ? 'checked' : ''}>Duplicates<small>The same file twice, versions, and files that are only alike</small></label></div>
      </section>

      <section class="card"><h2><span class="stepn">3</span>Preset and settings</h2>
        ${presetBarHtml(j)}
        <div id="settings">${settingsHtml(j)}</div>
      </section>

      <section class="card"><h2><span class="stepn">4</span>Scan</h2>
        <p class="hint">Sift only looks when you press Scan. Up to three jobs can scan at once.</p>
        <div id="scanArea">${scanAreaHtml()}</div>
      </section>
    </div>`;
  updatePresetState();
  wireScanArea($('#scanArea', main));

  const nameIn = $('#jobName', main);
  nameIn.onchange = () => {
    j.name = nameIn.value.trim() || j.name;
    nameIn.value = j.name;
    saveJob(j);
    renderTabs();
  };
  $('#dupJob', main).onclick = () => duplicateJob(j.id);
  $('#delJob', main).onclick = () => deleteJob(j.id);

  // Folders
  const fl = $('#flist', main);
  const redrawFolders = () => { fl.innerHTML = folderRowsHtml(j); updateScanArea(); };
  const moveFolder = (from, to) => {
    if (from === to || from < 0 || to < 0 || to >= j.folders.length) return;
    j.folders.splice(to, 0, j.folders.splice(from, 1)[0]);
    afterFolderChange(j);
    redrawFolders();
  };
  fl.onchange = (e) => {
    const a = e.target.closest('[data-act]');
    const r = e.target.closest('[data-rec]');
    if (a) j.folders[Number(a.dataset.act)].active = a.checked;
    else if (r) j.folders[Number(r.dataset.rec)].recursive = r.checked;
    else return;
    afterFolderChange(j);
    redrawFolders();
  };
  fl.onclick = async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.up) moveFolder(Number(b.dataset.up), Number(b.dataset.up) - 1);
    else if (b.dataset.down) moveFolder(Number(b.dataset.down), Number(b.dataset.down) + 1);
    else if (b.dataset.showf) invoke('open_file', { path: j.folders[Number(b.dataset.showf)].path }).catch(fail);
    else if (b.dataset.rm) {
      const f = j.folders[Number(b.dataset.rm)];
      if (!await askOnce('Remove this folder?', `${f.path} is taken out of Sift’s folders and out of every job. The folder itself is not touched.`, 'Remove folder')) return;
      await invoke('remove_folder', { path: f.path }).catch(fail);
      await reloadFolders();
      refreshPicks();
    }
  };
  let dragFrom = -1;
  fl.ondragstart = (e) => {
    const row = e.target.closest('.frow');
    if (!row) return;
    dragFrom = Number(row.dataset.i);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(dragFrom));
    row.classList.add('dragging');
  };
  fl.ondragover = (e) => {
    const row = e.target.closest('.frow');
    if (!row || dragFrom < 0) return;
    e.preventDefault();
    fl.querySelectorAll('.over').forEach((x) => x.classList.remove('over'));
    row.classList.add('over');
  };
  fl.ondrop = (e) => {
    const row = e.target.closest('.frow');
    if (!row || dragFrom < 0) return;
    e.preventDefault();
    const from = dragFrom;
    dragFrom = -1;
    moveFolder(from, Number(row.dataset.i));
  };
  fl.ondragend = () => { dragFrom = -1; fl.querySelectorAll('.dragging, .over').forEach((x) => x.classList.remove('dragging', 'over')); };

  $('#addFolder', main).onclick = async () => {
    try {
      const p = await invoke('pick_folder');
      if (p) { await invoke('add_folders', { jobId: j.id, paths: [p] }); await reloadFolders(); refreshPicks(); }
    } catch (e) { fail(e); }
  };
  $('#pasteBtn', main).onclick = () => {
    const box = $('#pastebox', main);
    box.hidden = !box.hidden;
    if (!box.hidden) $('#pasteIn', main).focus();
  };
  $('#pasteAdd', main).onclick = async () => {
    const paths = $('#pasteIn', main).value.split(/[;\n]+/).map((p) => p.trim().replace(/^"(.*)"$/, '$1')).filter(Boolean);
    if (!paths.length) return;
    try { await invoke('add_folders', { jobId: j.id, paths }); await reloadFolders(); refreshPicks(); toast(`${paths.length} folder${paths.length === 1 ? '' : 's'} added.`); } catch (e) { fail(e); }
  };
  main.querySelectorAll('[data-unskip]').forEach((b) => (b.onclick = async () => { await invoke('remove_skip', { pattern: S.overview.skip[b.dataset.unskip] }).catch(fail); await loadOverview(); render(); main.querySelector('.skipbox').open = true; }));
  const addSkip = async () => {
    const v = $('#skipIn', main).value.trim();
    if (!v) return;
    await invoke('add_skip', { pattern: v }).catch(fail);
    await loadOverview();
    render();
    $('#main .skipbox').open = true;
  };
  $('#addSkip', main).onclick = addSkip;
  $('#skipIn', main).onkeydown = (e) => { if (e.key === 'Enter') addSkip(); };

  // What to find: at least one stays on.
  main.querySelectorAll('[data-find]').forEach((c) => (c.onchange = () => {
    j[c.dataset.find] = c.checked;
    if (!j.findOld && !j.findDupes) { j[c.dataset.find] = true; c.checked = true; toast('A job has to look for at least one thing.'); return; }
    saveJob(j);
    $('#settings', main).innerHTML = settingsHtml(j);
    wireSettings();
    updatePresetState();
  }));

  // Preset
  const applyPreset = (p) => {
    j.findOld = p.findOld;
    j.findDupes = p.findDupes;
    j.settings = clone(p.settings);
    j.preset = p.id;
    saveJob(j);
    render();
  };
  $('#preset', main).onchange = (e) => {
    const p = allPresets().find((x) => x.id === e.target.value);
    if (p) applyPreset(p);
    else { j.preset = null; saveJob(j); updatePresetState(); }
  };
  $('#backPreset', main).onclick = () => applyPreset(presetStatus(j).p);
  $('#savePreset', main).onclick = async () => {
    const name = await askText('Save as preset', 'Name', presetStatus(j).p ? presetStatus(j).p.name + ' (mine)' : 'My preset', 'Save');
    if (!name) return;
    try {
      j.preset = await invoke('preset_save', { name, values: valuesOf(j) });
      await saveJob(j);
      await loadOverview();
      render();
      toast(`Saved as “${esc(name)}”. It is in the list for every job.`);
    } catch (e) { fail(e); }
  };
  const rn = $('#renamePreset', main);
  if (rn) rn.onclick = async () => {
    const name = await askText('Rename preset', 'Name', presetStatus(j).name, 'Rename');
    if (!name) return;
    await invoke('preset_rename', { id: j.preset, name }).catch(fail);
    await loadOverview();
    render();
  };
  const dl = $('#deletePreset', main);
  if (dl) dl.onclick = async () => {
    if (!await askOnce(`Delete the preset “${presetStatus(j).name}”?`, 'Jobs keep their settings; only the preset goes.', 'Delete preset')) return;
    await invoke('preset_delete', { id: j.preset }).catch(fail);
    j.preset = null;
    await loadOverview();
    render();
  };

  // Settings
  const changed = () => { saveJob(j); updatePresetState(); };
  function wireSettings() {
    const box = $('#settings', main);
    box.querySelectorAll('input[data-key]').forEach((inp) => {
      const it = SLIDERS.find((x) => x.key === inp.dataset.key);
      inp.oninput = () => { inp.nextElementSibling.textContent = it.label(it.fromUi(Number(inp.value))); };
      inp.onchange = () => { j.settings[it.key] = it.fromUi(Number(inp.value)); changed(); };
    });
    box.querySelectorAll('[data-kind]').forEach((c) => (c.onchange = () => {
      j.settings.kinds[c.dataset.kind] = c.checked;
      if (!Object.keys(GROUP).some((k) => j.settings.kinds[k])) { j.settings.kinds[c.dataset.kind] = true; c.checked = true; toast('Pick at least one kind of duplicate.'); return; }
      changed();
    }));
    box.querySelectorAll('[data-set]').forEach((c) => (c.onchange = () => { j.settings[c.dataset.set] = c.type === 'checkbox' ? c.checked : c.value; changed(); }));
    box.querySelectorAll('[data-date]').forEach((c) => (c.onchange = () => { j.settings[c.dataset.date] = fromDateStr(c.value, c.dataset.date === 'dateTo'); changed(); }));
    $('#exts', box).onchange = (e) => {
      j.settings.extensions = e.target.value.split(/[,;\s]+/).map((x) => x.trim().replace(/^\*?\./, '').toLowerCase()).filter(Boolean);
      e.target.value = j.settings.extensions.join(', ');
      changed();
    };
  }
  wireSettings();
}

// What is selected in both lists, each file once. A file picked in Duplicates counts as one.
function selectedForAct() {
  const out = new Map();
  for (const [kind, st] of [['dupes', S.dupes], ['old', S.old]]) {
    for (const id of st.sel) if (S.files.has(id) && !S.files.get(id).kept && !out.has(id)) out.set(id, kind);
  }
  return [...out.entries()].map(([id, kind]) => ({ id, kind }));
}

// ---------- Act ----------

const STRATEGIES = [['leave', 'Leave alone'], ['selected', 'As I selected'], ['folderOrder', 'Keep by folder order'], ['newest', 'Keep newest'], ['oldest', 'Keep oldest'], ['largest', 'Keep largest']];
const LEVELS = [
  { key: 'sure', label: 'Sure duplicates', desc: 'Copies and installer versions', opts: STRATEGIES, dupes: true, main: true },
  { key: 'notSure', label: 'Not sure', desc: 'Same content under other names, same name, similar names', opts: STRATEGIES, dupes: true, main: false },
  { key: 'old', label: 'Old downloads', desc: 'Files that look like leftovers', opts: STRATEGIES.slice(0, 2), dupes: false },
];

// What the filters show, on both lists: the files Act may touch.
function actScope() {
  const gs = groupsShown(true);
  const items = oldItems(true);
  return { gs, items };
}

function actBase() {
  const m = new Map();
  for (const f of dupBase()) m.set(f.id, f);
  for (const f of oldBase()) m.set(f.id, f);
  return [...m.values()];
}

function actRequest(scope) {
  const A = S.act;
  const st = S.dupes;
  const locked = [];
  for (const f of S.files.values()) if (isProtected(f)) locked.push(f.id);
  return {
    sure: A.sure,
    notSure: A.notSure,
    old: A.old,
    removal: A.removal === 'move' ? { type: 'move', to: A.moveTo, keepStructure: A.keepStructure } : { type: A.removal },
    moveKept: A.moveKept ? A.moveKeptTo : null,
    renameKept: A.renameKept,
    shownGroups: scope.gs.map((g) => ({ key: g.key, files: visOf(g) })),
    shownOld: scope.items.map((o) => o.file),
    selectedDupes: [...st.sel],
    selectedOld: [...S.old.sel],
    locked,
  };
}

// Choices that are missing something say so before anything is asked of the app.
function actProblem() {
  const A = S.act;
  if (A.removal === 'move' && !A.moveTo) return 'Choose the folder the files that go are moved to.';
  if (A.moveKept && !A.moveKeptTo) return 'Choose the folder the kept files are moved to.';
  return null;
}

const baseName = (p) => p.split(/[\\/]/).pop();
const dirName = (p) => p.slice(0, Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/')));

function fateText(it, skips) {
  if (it.fate === 'recycle') return 'Recycle Bin';
  if (it.fate === 'delete') return 'Deleted for good';
  if (it.fate === 'move') return `Moved to ${it.movedTo}`;
  let t = 'Stays';
  if (it.movedTo) t += ` · moved to ${dirName(it.movedTo)}`;
  if (it.renamedTo) t += ` · renamed to ${baseName(it.renamedTo)}`;
  const sk = skips.get(it.id);
  if (sk) t += ` · not renamed: ${sk}`;
  return t;
}

const ACT_COLS = (last) => [
  { label: 'Name', w: 240 },
  { label: 'Folder', w: 240 },
  { label: 'Size', w: 76, num: true },
  { label: 'Modified', w: 92 },
  { label: 'Created', w: 92 },
  { label: 'Type', w: 120 },
  { label: 'From', w: 120 },
  { label: last, w: 260 },
];

function renderAct(main) {
  if (!S.result) return noResult(main, 'Act');
  const j = job();
  const A = S.act;
  const F = S.f;
  const r = S.result;
  const actions = `<button class="btn toggle ${A.dry ? 'on' : ''}" id="dryRun" aria-pressed="${A.dry}" title="List what would happen to every file, without doing it">Dry run</button><button class="btn danger" id="goBtn" title="Do what the dry run lists">Go…</button>`;
  const levelRow = (L) => `<div class="level" data-level="${L.key}"><div><b>${L.label}</b><span class="muted"> ${L.desc}</span><div class="muted lstat" id="lstat-${L.key}"></div></div>
      <select class="btn" data-strategy="${L.key}" aria-label="${L.label}">${L.opts.map(([k, l]) => `<option value="${k}" ${A[L.key] === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>`;
  const levels = LEVELS.filter((L) => (L.dupes ? j.findDupes : j.findOld)).map(levelRow).join('');
  main.innerHTML = header('Act', 'Nothing happens until you press Go.', '<button class="btn" id="backToResults">‹ Results</button>') +
    topbarHtml(F, '', actions) + `
    <div class="actpanel">
      <section><h3>What to do, per certainty</h3>${levels}</section>
      <section><h3>The files that go</h3>
        <label class="tgl"><input type="radio" class="check radio" name="removal" value="recycle" ${A.removal === 'recycle' ? 'checked' : ''}>Recycle Bin <span class="muted">(you can put them back)</span></label>
        <div><label class="tgl"><input type="radio" class="check radio" name="removal" value="move" ${A.removal === 'move' ? 'checked' : ''}>Move to a folder</label>
          <div class="sub2" ${A.removal === 'move' ? '' : 'hidden'}><button class="btn small" id="pickMove">Choose folder…</button><span class="p muted" id="moveTo" title="${esc(A.moveTo)}">${esc(A.moveTo || 'No folder chosen')}</span>
            <label class="tgl small"><input type="checkbox" class="check" id="keepStructure" ${A.keepStructure ? 'checked' : ''}>Keep the folder structure</label></div></div>
        <div><label class="tgl"><input type="radio" class="check radio" name="removal" value="delete" ${A.removal === 'delete' ? 'checked' : ''}>Delete permanently</label>
          <div class="sub2 dangertext" ${A.removal === 'delete' ? '' : 'hidden'}>They do not go to the Recycle Bin and can’t be put back. Sift asks once more before it does it.</div></div>
      </section>
      <section><h3>The file that stays <span class="muted">(optional)</span></h3>
        <div><label class="tgl"><input type="checkbox" class="check" id="moveKept" ${A.moveKept ? 'checked' : ''}>Move it to a folder</label>
          <div class="sub2" ${A.moveKept ? '' : 'hidden'}><button class="btn small" id="pickKept">Choose folder…</button><span class="p muted" id="keptTo" title="${esc(A.moveKeptTo)}">${esc(A.moveKeptTo || 'No folder chosen')}</span></div></div>
        <label class="tgl" title="Drops “(1)”, “ - Copy” or a trailing number from its name, when no file with the clean name is left in that folder"><input type="checkbox" class="check" id="renameKept" ${A.renameKept ? 'checked' : ''}>Rename it to its clean name</label>
        <div class="muted hint2">“report (1).pdf” becomes “report.pdf”, when no “report.pdf” is left in that folder.</div>
      </section>
    </div>
    <div class="actsum" id="actsum"></div>
    <div class="table" id="table"></div>`;

  let scope = actScope();
  let seq = 0;
  const redrawNow = async () => {
    const mine = ++seq;
    scope = actScope();
    const hidden = r.groups.length - scope.gs.length;
    $('#counts', main).textContent = `${nf.format(scope.gs.length)} of ${nf.format(r.groups.length)} groups shown${hidden ? ` · ${nf.format(hidden)} hidden, left alone` : ''} · ${nf.format(scope.items.length)} of ${nf.format(r.old.length)} old files shown`;
    for (const L of LEVELS) {
      const el = $('#lstat-' + L.key, main);
      if (!el) continue;
      if (L.dupes) {
        const gs = scope.gs.filter((g) => !!GROUP[g.kind].main === L.main);
        const n = gs.reduce((a, g) => a + visOf(g).filter((id) => S.dupes.sel.has(id)).length, 0);
        el.textContent = `${nf.format(gs.length)} group${gs.length === 1 ? '' : 's'} shown · ${nf.format(n)} file${n === 1 ? '' : 's'} selected`;
      } else {
        const n = scope.items.filter((o) => S.old.sel.has(o.file)).length;
        el.textContent = `${nf.format(scope.items.length)} file${scope.items.length === 1 ? '' : 's'} shown · ${nf.format(n)} selected`;
      }
    }
    if (A.dry) {
      const problem = actProblem();
      if (problem) { A.plan = null; drawTable(problem); return; }
      try {
        const plan = await invoke('plan_act', { jobId: S.jobId, req: actRequest(scope) });
        if (mine !== seq) return;
        A.plan = plan;
      } catch (e) { fail(e); A.plan = null; }
    }
    drawTable();
  };
  let timer = null;
  const redraw = () => { clearTimeout(timer); timer = setTimeout(redrawNow, 60); };

  const drawTable = (problem) => {
    const tbl = $('#table', main);
    const sum = $('#actsum', main);
    let defs, rowsOf, rowHtml;
    if (A.dry) {
      const p = A.plan;
      if (!p) {
        sum.innerHTML = problem ? `<span class="dangertext">${esc(problem)}</span>` : '';
        tbl.innerHTML = '<div class="empty"><h2>Dry run</h2><p>' + esc(problem || 'Working it out…') + '</p></div>';
        return;
      }
      const t = p.totals;
      const skips = new Map(p.skipped.map((s) => [s.id, s.reason]));
      const bits = [`<b>${nf.format(t.go)}</b> file${t.go === 1 ? '' : 's'} go · ${size(t.goBytes)}`, `${nf.format(t.stay)} stay`];
      if (t.keptMoved) bits.push(`${nf.format(t.keptMoved)} kept moved`);
      if (t.renamed) bits.push(`${nf.format(t.renamed)} renamed`);
      if (p.skipped.length) bits.push(`${nf.format(p.skipped.length)} not renamed (name taken)`);
      if (p.undecided) bits.push(`${nf.format(p.undecided)} group${p.undecided === 1 ? '' : 's'} left alone: folder order can’t tell`);
      sum.innerHTML = `${bits.join(' · ')}` + (p.wiped.length ? `<div class="warnbox">In ${p.wiped.length} duplicate group${p.wiped.length === 1 ? '' : 's'} every file would go, so none of that file stays: ${p.wiped.slice(0, 3).map((l) => '“' + esc(l) + '”').join(', ')}${p.wiped.length > 3 ? '…' : ''}</div>` : '');
      // Files of one group sit together; old downloads come last.
      const order = new Map();
      for (const it of p.items) { const k = it.group ?? '￿'; if (!order.has(k)) order.set(k, order.size); }
      const items = p.items.slice().sort((a, b) => order.get(a.group ?? '￿') - order.get(b.group ?? '￿'));
      defs = ACT_COLS('What happens');
      rowsOf = items;
      rowHtml = (i) => {
        const it = items[i];
        const f = S.files.get(it.id);
        const stays = it.fate === 'stays';
        return { cls: `member ${stays ? 'stays' : ''}`, html: `${actCells(f)}<div class="fate ${it.fate}" title="${esc(it.group || '')}">${esc(fateText(it, skips))}</div>` };
      };
    } else {
      const ids = new Map();
      for (const g of scope.gs) for (const id of visOf(g)) if (S.dupes.sel.has(id) && !ids.has(id)) ids.set(id, `${GROUP[g.kind].label}: ${g.label}`);
      for (const o of scope.items) if (S.old.sel.has(o.file) && !ids.has(o.file)) ids.set(o.file, 'Old: ' + o.signals.map((s) => REASON[s.type].text(s)).join(', '));
      const list = [...ids.entries()];
      const bytes = list.reduce((a, [id]) => a + S.files.get(id).size, 0);
      sum.innerHTML = `${nf.format(list.length)} file${list.length === 1 ? '' : 's'} selected on Results and shown here · ${size(bytes)}. Press <b>Dry run</b> to see what each choice would do to every file.`;
      defs = ACT_COLS('Selected as');
      rowsOf = list;
      rowHtml = (i) => ({ cls: '', html: `${actCells(S.files.get(list[i][0]))}<div class="muted" title="${esc(list[i][1])}">${esc(list[i][1])}</div>` });
    }
    tbl.innerHTML = `<div class="thead">${headCells(defs, {})}</div><div class="scroller" id="list" tabindex="0"></div>`;
    columns(tbl, A.dry ? 'actdry' : 'act', defs);
    const sc = $('#list', tbl);
    if (!rowsOf.length) sc.innerHTML = `<div class="empty"><h2>${A.dry ? 'Nothing would happen' : 'Nothing selected here'}</h2><p>${A.dry ? 'With these choices and filters no file is touched.' : 'Pick files on Results, or choose a way of keeping one file per group above.'}</p></div>`;
    else virtualList(sc, rowsOf.length, rowHtml);
  };
  const actCells = (f) => `<div class="name" title="${esc(f.path)}">${esc(f.name)}</div>${folderPlain(f)}<div class="num">${size(f.size)}</div>${dateCell(f.modified)}${dateCell(f.created)}${typeCell(f)}${originCell(f)}`;
  const folderPlain = (f) => `<div class="muted" title="${esc(f.dir)}">${esc(f.dir)}</div>`;

  // The bar.
  wireTopbar(main, F, actBase, () => {
    // Only what passes the filters stays selected, so nothing hidden can go along unseen.
    const shown = new Set();
    for (const g of groupsShown(true)) for (const id of visOf(g)) shown.add(id);
    for (const id of [...S.dupes.sel]) if (!shown.has(id)) S.dupes.sel.delete(id);
    const old = new Set(oldItems(true).map((o) => o.file));
    for (const id of [...S.old.sel]) if (!old.has(id)) S.old.sel.delete(id);
    selectionChanged();
    redraw();
  }, 'Date');
  $('#backToResults', main).onclick = () => setStep('results');
  $('#dryRun', main).onclick = (e) => {
    A.dry = !A.dry;
    A.plan = null;
    e.currentTarget.classList.toggle('on', A.dry);
    e.currentTarget.setAttribute('aria-pressed', A.dry);
    redraw();
  };
  main.querySelectorAll('[data-strategy]').forEach((s) => (s.onchange = () => { A[s.dataset.strategy] = s.value; redraw(); }));
  main.querySelectorAll('[name=removal]').forEach((c) => (c.onchange = () => {
    A.removal = c.value;
    main.querySelectorAll('.actpanel section:nth-child(2) .sub2').forEach((x, i) => { x.hidden = (i === 0 ? 'move' : 'delete') !== A.removal; });
    redraw();
  }));
  const pick = async (key, labelId) => {
    const p = await invoke('pick_folder').catch(fail);
    if (!p) return;
    A[key] = p;
    $('#' + labelId, main).textContent = p;
    $('#' + labelId, main).title = p;
    redraw();
  };
  $('#pickMove', main).onclick = () => pick('moveTo', 'moveTo');
  $('#pickKept', main).onclick = () => pick('moveKeptTo', 'keptTo');
  $('#keepStructure', main).onchange = (e) => { A.keepStructure = e.target.checked; redraw(); };
  $('#moveKept', main).onchange = (e) => {
    A.moveKept = e.target.checked;
    e.target.closest('div').querySelector('.sub2').hidden = !A.moveKept;
    redraw();
  };
  $('#renameKept', main).onchange = (e) => { A.renameKept = e.target.checked; redraw(); };
  $('#goBtn', main).onclick = () => goAct(scope);
  redrawNow();
}

const OP_LABEL = { recycle: 'Recycle', move: 'Move', rename: 'Rename', delete: 'Delete' };

// Works out the plan afresh, shows every step for a last look, and does it.
async function goAct(scope) {
  const A = S.act;
  const problem = actProblem();
  if (problem) { toast(problem); return; }
  let plan;
  try { plan = await invoke('plan_act', { jobId: S.jobId, req: actRequest(scope) }); } catch (e) { fail(e); return; }
  if (!plan.ops.length) { toast('With these choices nothing would happen.'); return; }
  const permanent = A.removal === 'delete' && plan.totals.go > 0;
  const t = plan.totals;
  const parts = [];
  if (t.go) parts.push(A.removal === 'recycle' ? `${nf.format(t.go)} to the Recycle Bin` : A.removal === 'move' ? `${nf.format(t.go)} moved to ${A.moveTo}` : `${nf.format(t.go)} deleted for good`);
  if (t.keptMoved) parts.push(`${nf.format(t.keptMoved)} kept file${t.keptMoved === 1 ? '' : 's'} moved`);
  if (t.renamed) parts.push(`${nf.format(t.renamed)} renamed`);
  const d = $('#confirm');
  d.innerHTML = `<div class="dh"><h2>${permanent ? `Delete ${nf.format(t.go)} file${t.go === 1 ? '' : 's'} for good?` : 'Do this?'}</h2>
      <p>${parts.join(' · ')}${t.go ? ` · ${size(t.goBytes)}` : ''}. ${permanent ? 'Deleted files do not go to the Recycle Bin.' : 'Every step is written in History, where it can be undone.'}</p></div>
    ${plan.wiped.length ? `<div class="warnbox">In ${plan.wiped.length} duplicate group${plan.wiped.length === 1 ? '' : 's'} every file goes, so none of that file stays: ${plan.wiped.slice(0, 3).map((l) => '“' + esc(l) + '”').join(', ')}${plan.wiped.length > 3 ? '…' : ''}</div>` : ''}
    ${plan.skipped.length ? `<div class="warnbox">${plan.skipped.length} kept file${plan.skipped.length === 1 ? '' : 's'} will not be renamed because the clean name is taken: ${plan.skipped.slice(0, 3).map((s) => '“' + esc(baseName(s.path)) + '”').join(', ')}${plan.skipped.length > 3 ? '…' : ''}</div>` : ''}
    <div class="dl">${plan.ops.map((o) => `<div><span class="k">${OP_LABEL[o.kind]}</span><span class="n" title="${esc(o.from)}${o.to ? '\n→ ' + esc(o.to) : ''}">${esc(o.from)}${o.to ? ' → ' + esc(o.to) : ''}</span><span class="s">${size(S.files.get(o.id)?.size || 0)}</span></div>`).join('')}</div>
    <div class="df"><button class="btn" id="dCancel">Cancel</button><button class="btn ${permanent ? 'danger' : 'primary'}" id="dGo">${permanent ? 'Delete…' : 'Go'}</button></div>`;
  d.onclose = null;
  d.showModal();
  $('#dCancel', d).focus();
  $('#dCancel', d).onclick = () => d.close();
  const goBtn = $('#dGo', d);
  goBtn.onclick = async () => {
    let confirmed = false;
    if (permanent) {
      // The same dialog asks again, so the first question is never answered by a close event.
      if (!await askOnce(`Delete ${nf.format(t.go)} file${t.go === 1 ? '' : 's'} for good?`, 'This can’t be undone. The files will not go to the Recycle Bin, and Sift cannot put them back.', 'Delete for good')) return;
      confirmed = true;
    }
    goBtn.disabled = true;
    goBtn.textContent = 'Working…';
    try {
      const before = Math.max(0, ...S.overview.removals.map((x) => x.id));
      const out = await invoke('act', { jobId: S.jobId, req: actRequest(scope), confirmedDelete: confirmed });
      d.close();
      await flushState();
      await reloadJob(S.jobId);
      await loadOverview();
      A.plan = null;
      A.dry = false;
      render();
      const done = [['recycled', out.recycled], ['moved', out.moved], ['renamed', out.renamed], ['deleted', out.deleted]].filter(([, n]) => n).map(([w, n]) => `${nf.format(n)} ${w}`);
      const undoable = S.overview.removals.filter((x) => x.id > before && !x.restoredAt && x.kind !== 'deleted' && (x.kind !== 'recycled' || S.overview.canPutBack));
      toast((done.join(', ') || 'Nothing done') + '.' + (out.failed.length ? ` ${out.failed.length} could not be done: ${esc(out.failed[0].error)}` : ''), undoable.length ? { label: 'Undo', run: () => undoEntries(undoable.map((x) => x.id)) } : null);
    } catch (e) {
      d.close();
      fail(e);
    }
  };
}

// Undoes History entries, the newest first (a rename before the move it followed).
async function undoEntries(ids) {
  let ok = 0, bad = [];
  for (const id of ids.slice().sort((a, b) => b - a)) {
    try { await invoke('undo', { id }); ok++; } catch (e) { bad.push(String(e)); }
  }
  await loadOverview();
  render();
  toast(`${nf.format(ok)} undone.` + (bad.length ? ` ${bad.length} could not: ${esc(bad[0])}` : '') + (ok ? ' Scan again to see the files in the lists.' : ''));
}

// ---------- History ----------

const KIND_TEXT = { recycled: 'Recycle Bin', moved: 'Moved', renamed: 'Renamed', deleted: 'Deleted for good' };
const UNDO_TEXT = { recycled: 'Put back', moved: 'Move back', renamed: 'Rename back' };

function renderHistory(main) {
  const o = S.overview;
  const rem = o.removals;
  const freed = rem.filter((x) => !x.restoredAt && (x.kind === 'recycled' || x.kind === 'deleted')).reduce((a, x) => a + x.size, 0);
  const entry = (x) => {
    const where = x.to ? ` → ${x.to}` : '';
    const undo = x.restoredAt ? '<span class="tag">undone</span>'
      : x.kind === 'deleted' ? '<span class="tag warn" title="Deleted for good: Sift cannot bring it back">can’t be undone</span>'
        : x.kind === 'recycled' && !o.canPutBack ? '' : `<button class="linkbtn" data-back="${x.id}">${UNDO_TEXT[x.kind]}</button>`;
    return `<div class="li"><span class="tag ${x.kind === 'deleted' ? 'warn' : ''}">${KIND_TEXT[x.kind] || x.kind}</span>
      <span class="p" title="${esc(x.path + where)}\n${esc(x.reason)}">${esc(x.path + where)}</span>
      <span class="m" title="${esc(fullDate(x.at))}">${size(x.size)} · ${ago(x.at)}</span>${undo}</div>`;
  };
  main.innerHTML = header('History', `${nf.format(rem.length)} step${rem.length === 1 ? '' : 's'} · ${size(freed)} taken off the disk`) + `<div class="page">
    <div class="card wide"><h2>What Sift did to files</h2><p class="hint">Newest first. Put back, move back and rename back undo a step as long as the file is still where Sift left it. A permanent delete can’t be undone.</p>
      <div class="list">${rem.length ? rem.slice(0, 1000).map(entry).join('') : '<div class="empty-list">Nothing done yet.</div>'}</div></div>
    <div class="card wide"><h2>Scans</h2>
      <div class="list">${o.scans.length ? o.scans.map((s) => `<div class="li">
        <span class="p" title="${esc(s.folders)}">${esc(fullDate(s.startedAt))}${s.cancelled ? ' <span class="tag">stopped</span>' : ''}</span>
        <span class="m">${nf.format(s.filesSeen)} files · ${size(s.bytesSeen)} · ${nf.format(s.oldCount)} old · ${nf.format(s.groupCount)} duplicate groups</span></div>`).join('') : '<div class="empty-list">No scans yet.</div>'}</div></div>
  </div>`;
  main.querySelectorAll('[data-back]').forEach((b) => (b.onclick = () => undoEntries([Number(b.dataset.back)])));
}

// ---------- Pages in the strip ----------

function renderWindows(main) {
  main.innerHTML = header('Windows cleaning', '') + `<div class="page"><div class="empty"><h2>Comes later</h2>
    <p>Startup programs and temporary files will be looked at here. Nothing to do yet.</p></div></div>`;
}

function renderKept(main) {
  const o = S.overview;
  main.innerHTML = header('Kept and protected', 'What Sift never suggests, and what can never be selected.') + `<div class="page">
    <div class="card"><h2>Kept files</h2><p class="hint">Files you chose to keep. Sift never suggests them for removal.</p>
      <div class="list">${o.kept.length ? o.kept.slice(0, 500).map((k, i) => `<div class="li"><span class="p" title="${esc(k.path)}">${esc(k.path)}</span><span class="m">${ago(k.at)}</span><button class="linkbtn quiet" data-unkeep="${i}">Stop keeping</button></div>`).join('') : '<div class="empty-list">None yet. Use Keep on a file in the lists.</div>'}</div></div>

    <div class="card"><h2>Protected</h2><p class="hint">Files whose path matches one of these can never be selected for removal. Use * for anything, like <b>*\\Photos\\*</b>.</p>
      <div class="list">${pref('protect', []).length ? pref('protect', []).map((p, i) => `<div class="li"><span class="p">${esc(p)}</span><button class="linkbtn quiet" data-unprotect="${i}">Remove</button></div>`).join('') : '<div class="empty-list">Nothing protected.</div>'}</div>
      <div class="addrow"><input id="protIn" placeholder="A path or a pattern"><button class="btn" id="addProt">Add</button></div></div>
  </div>`;
  main.querySelectorAll('[data-unkeep]').forEach((b) => (b.onclick = async () => {
    await invoke('unkeep', { paths: [o.kept[b.dataset.unkeep].path] }).catch(fail);
    await flushState();
    if (S.jobId != null) await reloadJob(S.jobId).catch(fail);
    await loadOverview();
    render();
  }));
  main.querySelectorAll('[data-unprotect]').forEach((b) => (b.onclick = async () => { const l = pref('protect', []); l.splice(Number(b.dataset.unprotect), 1); await savePref('protect', l); render(); }));
  const addProt = async () => {
    const v = $('#protIn', main).value.trim();
    if (!v) return;
    const l = pref('protect', []);
    if (!l.includes(v)) l.push(v);
    await savePref('protect', l);
    render();
  };
  $('#addProt', main).onclick = addProt;
  $('#protIn', main).onkeydown = (e) => { if (e.key === 'Enter') addProt(); };
}

// ---------- Start ----------

async function start() {
  $('#tabs').onclick = (e) => {
    if (e.target.closest('#addJob')) return newJob();
    const t = e.target.closest('[data-job]');
    if (t) openJob(Number(t.dataset.job));
  };
  $('#steps').onclick = (e) => {
    const b = e.target.closest('[data-step]');
    if (b) setStep(b.dataset.step);
  };
  document.querySelectorAll('#strip [data-view]').forEach((b) => (b.onclick = () => go(b.dataset.view)));
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) {
      const q = $('#q');
      if (q) { e.preventDefault(); q.focus(); q.select(); }
    }
  });
  await T.event.listen('scan-progress', (ev) => {
    const p = ev.payload;
    rtOf(p.jobId).progress = p;
    updateBadge(p.jobId);
    if (p.jobId === S.jobId) updateScanArea();
  });
  try {
    await loadOverview(true);
    if (!S.jobs.length) S.jobs.push(await invoke('job_create'));
    const wanted = jobById(Number(S.overview.settings.activeJob)) || S.jobs[0];
    await openJob(wanted.id);
  } catch (e) { fail(e); }
}

start();
