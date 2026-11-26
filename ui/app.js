// Sift's window. Plain JavaScript, no framework: one state object, pages drawn from it, long
// lists drawn only where they are visible so tens of thousands of files stay smooth.
'use strict';

const T = window.__TAURI__;
const invoke = (cmd, args) => T.core.invoke(cmd, args);

// ---------- State ----------

const DEFAULTS = { untouchedMonths: 6, archiveMonths: 3, minDupeSize: 1024, similarNames: 95 };

const S = {
  view: 'old',
  overview: null,
  result: null,
  files: new Map(),
  scanning: false,
  progress: null,
  old: { f: null, reasons: new Set(), sort: { key: 'size', asc: false }, groupBy: 'none', folded: new Set(), onlySel: false, sel: new Set(), focus: -1, anchor: -1 },
  dupes: { f: null, kinds: new Set(), notSure: false, show: 'all', gsort: 'kind', showDismissed: false, keys: false, sel: new Set(), focus: -1, anchor: -1 },
};

const setting = (k) => {
  const v = S.overview && S.overview.settings[k];
  return v === undefined ? DEFAULTS[k] : Number(v);
};

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

// ---------- Loading ----------

async function loadOverview() {
  S.overview = await invoke('overview');
}

function setResult(r) {
  S.result = r;
  S.files = new Map(r ? r.files.map((f) => [f.id, f]) : []);
  for (const st of [S.old, S.dupes]) {
    for (const id of [...st.sel]) if (!canSelect(S.files.get(id))) st.sel.delete(id);
    st.focus = -1;
  }
}

async function loadResult() {
  const json = await invoke('last_result');
  setResult(json ? JSON.parse(json) : null);
}

// ---------- Sidebar ----------

function scanText() {
  const r = S.result;
  if (S.scanning) {
    const p = S.progress;
    if (!p || p.phase === 'looking') return p ? `Looking… ${nf.format(p.files)} files` : 'Starting…';
    if (p.phase === 'comparing') return `Comparing contents… ${p.total ? Math.min(100, Math.round((p.done / p.total) * 100)) : 100}%`;
    return 'Checking what is old…';
  }
  return r ? `Last scan ${ago(r.finishedAt)}` : 'Not scanned yet';
}

function paintBar(bar) {
  if (!bar) return;
  bar.hidden = !S.scanning;
  const p = S.progress;
  const comparing = S.scanning && p && p.phase === 'comparing';
  bar.classList.toggle('busy', S.scanning && !comparing);
  bar.firstElementChild.style.width = comparing ? (p.total ? Math.min(100, Math.round((p.done / p.total) * 100)) : 100) + '%' : '';
}

function renderSide() {
  document.querySelectorAll('.navitem').forEach((b) => b.classList.toggle('on', b.dataset.view === S.view));
  const r = S.result;
  $('#countOld').textContent = r ? nf.format(r.old.length) : '';
  $('#countDupes').textContent = r ? nf.format(r.groups.filter((g) => GROUP[g.kind] && GROUP[g.kind].main).length) : '';
  $('#scanInfo').textContent = scanText();
  $('#scanInfo').title = r && !S.scanning ? fullDate(r.finishedAt) : '';
  paintBar($('#scanBar'));
  // The scan page shows the same progress where the button is.
  const st = $('#scanState');
  if (st) {
    $('#scanStateText').textContent = scanText();
    paintBar($('#scanPageBar'));
    const btn = $('#scanGo');
    btn.textContent = S.scanning ? 'Stop' : r ? 'Scan again' : 'Scan';
    btn.classList.toggle('primary', !S.scanning);
  }
}

async function scanOrStop() {
  if (S.scanning) {
    invoke('cancel_scan');
    return;
  }
  const enabled = (S.overview.folders || []).filter((f) => f.enabled);
  if (!enabled.length) {
    go('scan');
    toast('Add a folder to look in first.');
    return;
  }
  S.scanning = true;
  S.progress = null;
  renderSide();
  try {
    const json = await invoke('scan');
    const r = JSON.parse(json);
    if (r.cancelled) {
      toast('Scan stopped. The earlier results are still here.');
    } else {
      setResult(r);
      toast(`Looked at ${nf.format(r.stats.filesSeen)} files (${size(r.stats.bytesSeen)}).`);
    }
  } catch (e) {
    fail(e);
  }
  S.scanning = false;
  S.progress = null;
  await loadOverview();
  render();
}

// ---------- Router ----------

function go(view) {
  closePopover();
  S.view = view;
  render();
}

function render() {
  renderSide();
  const main = $('#main');
  main.innerHTML = '';
  ({ scan: renderScan, old: renderOld, dupes: renderDupes, history: renderHistory, kept: renderKept })[S.view](main);
}

const SEARCH_ICON = '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/></svg>';

function header(title, sub, extra = '') {
  return `<div class="head"><div><h1>${esc(title)}</h1><div class="sub">${sub}</div></div><div class="grow"></div>${extra}</div>`;
}

function noResult(main, title) {
  main.innerHTML = header(title, '') + `<div class="page"><div class="empty"><h2>Nothing scanned yet</h2>
    <p>Start at step 1: choose where to look and what counts, then scan.</p>
    <button class="btn primary" id="emptyScan">Go to step 1, Scan</button></div></div>`;
  $('#emptyScan').onclick = () => go('scan');
}

// Under each result page's title: which scan the list comes from, and the way back to step 1.
function fromScan() {
  return S.result ? ` · from the scan ${ago(S.result.finishedAt)} <button class="linkbtn" data-goscan>change and scan again</button>` : '';
}
document.addEventListener('click', (e) => { if (e.target.closest('[data-goscan]')) go('scan'); });


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
  return `<div class="rowacts"><button class="linkbtn quiet" data-act="show" data-id="${id}" title="Show in File Explorer">Show</button><button class="linkbtn quiet" data-act="keep" data-id="${id}" title="Never suggest this file again">Keep</button></div>`;
}

function wireRowActions(scroller, after) {
  scroller.addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    e.stopPropagation();
    const f = S.files.get(Number(b.dataset.id));
    if (!f) return;
    if (b.dataset.act === 'show') invoke('show_in_folder', { path: f.path }).catch(fail);
    if (b.dataset.act === 'keep') await keepFiles([f.id], after);
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
        await loadResult();
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
      <button class="btn small" id="patProtect" title="Never let files matching this path be selected (kept between runs; see Where to look)">Protect</button>
    </div>
    <div class="grow"></div>
    ${extraButtons}
    <button class="btn" id="selKeep">Keep</button>
    <button class="btn danger" id="selRecycle">Move to Recycle Bin…</button>
  </div>`;
}

function wireSelbar(main, st, visibleIds, refresh, recycleFn) {
  const update = () => {
    const ids = [...st.sel];
    const bytes = ids.reduce((a, id) => a + (S.files.get(id)?.size || 0), 0);
    $('#selWhat', main).innerHTML = ids.length ? `${nf.format(ids.length)} selected <span>· ${size(bytes)}</span>` : '<span>Nothing selected</span>';
    $('#selRecycle', main).disabled = !ids.length;
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

// ---------- Filters (shared by both result pages) ----------

const SIZE_STEPS = [0, 1024, 100 * 1024, 1 << 20, 10 << 20, 100 << 20, 1 << 30, 10 * 2 ** 30, Infinity];
const AGE_STEPS = [0, 1, 7, 30, 91, 182, 365, 730, 1825, Infinity]; // days
const ageLabel = (d) => (d === 0 || d === Infinity ? 'any' : d < 7 ? d + ' day' : d < 30 ? d / 7 + (d === 7 ? ' week' : ' weeks') : d < 365 ? Math.round(d / 30.4) + (d < 60 ? ' month' : ' months') : d / 365 + (d === 365 ? ' year' : ' years'));

function newFilter() {
  return { query: '', kinds: new Set(), exts: new Set(), dirs: new Set(), origins: new Set(), sizeMin: 0, sizeMax: SIZE_STEPS.length - 1, olderThan: 0, newerThan: AGE_STEPS.length - 1 };
}
S.old.f = newFilter();
S.dupes.f = newFilter();

const extOf = (f) => (f.ext ? '.' + f.ext : '(no extension)');
const originOf = (f) => f.origin || '(not known)';
const FACETS = {
  kinds: { label: 'Type', of: (f) => f.kind, show: (v) => KIND_LABEL[v] || v },
  exts: { label: 'Extension', of: extOf, show: (v) => v },
  dirs: { label: 'Folder', of: (f) => f.dir, show: (v) => v },
  origins: { label: 'From', of: originOf, show: (v) => v },
};

function filterActive(F) {
  return F.query.trim() || F.kinds.size || F.exts.size || F.dirs.size || F.origins.size || F.sizeMin > 0 || F.sizeMax < SIZE_STEPS.length - 1 || F.olderThan > 0 || F.newerThan < AGE_STEPS.length - 1;
}

// Does one file pass the filters? `dateOf` is the date the age sliders look at.
function fileMatches(f, F, dateOf) {
  const q = F.query.trim().toLowerCase();
  if (q && !f.path.toLowerCase().includes(q)) return false;
  for (const k of Object.keys(FACETS)) if (F[k].size && !F[k].has(FACETS[k].of(f))) return false;
  if (f.size < SIZE_STEPS[F.sizeMin] || f.size > SIZE_STEPS[F.sizeMax]) return false;
  const days = (Date.now() / 1000 - dateOf(f)) / 86400;
  if (days < AGE_STEPS[F.olderThan]) return false;
  if (AGE_STEPS[F.newerThan] !== Infinity && days > AGE_STEPS[F.newerThan]) return false;
  return true;
}

function filterBarHtml(F, dateWord, chipsHtml) {
  const pop = (k) => `<button class="btn small popbtn ${F[k].size ? 'on' : ''}" data-pop="${k}">${FACETS[k].label}${F[k].size ? ` <span class="n">${F[k].size}</span>` : ''} ▾</button>`;
  const sizeLabel = (i, end) => (i === 0 && !end ? 'no minimum' : SIZE_STEPS[i] === Infinity ? 'no maximum' : size(SIZE_STEPS[i]));
  return `<div class="filters">
      <label class="search">${SEARCH_ICON}<input id="q" placeholder="Search name or folder" value="${esc(F.query)}"></label>
      ${pop('kinds')}${pop('exts')}${pop('dirs')}${pop('origins')}
      <button class="linkbtn" id="clearFilters" ${filterActive(F) ? '' : 'hidden'}>Clear all filters</button>
    </div>
    <div class="filters ranges">
      <div class="slide">Size from <input type="range" id="sizeMin" min="0" max="${SIZE_STEPS.length - 2}" value="${F.sizeMin}"><output id="sizeMinOut">${sizeLabel(F.sizeMin)}</output>
        to <input type="range" id="sizeMax" min="1" max="${SIZE_STEPS.length - 1}" value="${F.sizeMax}"><output id="sizeMaxOut">${sizeLabel(F.sizeMax, true)}</output></div>
      <div class="slide">${dateWord} more than <input type="range" id="older" min="0" max="${AGE_STEPS.length - 2}" value="${F.olderThan}"><output id="olderOut">${ageLabel(AGE_STEPS[F.olderThan])}</output>
        and less than <input type="range" id="newer" min="1" max="${AGE_STEPS.length - 1}" value="${F.newerThan}"><output id="newerOut">${ageLabel(AGE_STEPS[F.newerThan])}</output> ago</div>
    </div>
    ${chipsHtml ? `<div class="filters" style="padding-top:0"><div class="chips">${chipsHtml}</div></div>` : ''}`;
}

// Wires the bar. `baseFiles()` gives the files the choice lists count over.
function wireFilterBar(main, F, baseFiles, onChange) {
  const changed = () => {
    $('#clearFilters', main).hidden = !filterActive(F);
    onChange();
  };
  $('#q', main).oninput = (e) => { F.query = e.target.value; changed(); };
  const sizeLabel = (i, end) => (i === 0 && !end ? 'no minimum' : SIZE_STEPS[i] === Infinity ? 'no maximum' : size(SIZE_STEPS[i]));
  const range = (id, key, label, fix) => {
    $('#' + id, main).oninput = (e) => {
      F[key] = Number(e.target.value);
      fix();
      $('#' + id + 'Out', main).textContent = label(F[key]);
      changed();
    };
  };
  range('sizeMin', 'sizeMin', (i) => sizeLabel(i), () => { if (F.sizeMax <= F.sizeMin) { F.sizeMax = F.sizeMin + 1; $('#sizeMax', main).value = F.sizeMax; $('#sizeMaxOut', main).textContent = sizeLabel(F.sizeMax, true); } });
  range('sizeMax', 'sizeMax', (i) => sizeLabel(i, true), () => { if (F.sizeMin >= F.sizeMax) { F.sizeMin = F.sizeMax - 1; $('#sizeMin', main).value = F.sizeMin; $('#sizeMinOut', main).textContent = sizeLabel(F.sizeMin); } });
  range('older', 'olderThan', (i) => ageLabel(AGE_STEPS[i]), () => { if (F.newerThan <= F.olderThan) { F.newerThan = F.olderThan + 1; $('#newer', main).value = F.newerThan; $('#newerOut', main).textContent = ageLabel(AGE_STEPS[F.newerThan]); } });
  range('newer', 'newerThan', (i) => ageLabel(AGE_STEPS[i]), () => { if (F.olderThan >= F.newerThan) { F.olderThan = F.newerThan - 1; $('#older', main).value = F.olderThan; $('#olderOut', main).textContent = ageLabel(AGE_STEPS[F.olderThan]); } });
  $('#clearFilters', main).onclick = () => {
    Object.assign(F, newFilter());
    render();
  };
  main.querySelectorAll('[data-pop]').forEach((b) => (b.onclick = (e) => { e.stopPropagation(); openFacet(b, F, b.dataset.pop, baseFiles, () => {
    const n = F[b.dataset.pop].size;
    b.classList.toggle('on', n > 0);
    b.innerHTML = `${FACETS[b.dataset.pop].label}${n ? ` <span class="n">${n}</span>` : ''} ▾`;
    changed();
  }); }));
}

// A list of choices with counts and a search box, under its button.
function openFacet(btn, F, key, baseFiles, onChange) {
  closePopover();
  const counts = new Map();
  for (const f of baseFiles()) {
    const v = FACETS[key].of(f);
    counts.set(v, (counts.get(v) || 0) + 1);
  }
  const all = [...counts.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
  const pop = document.createElement('div');
  pop.className = 'popover';
  pop.innerHTML = `<input class="popq" placeholder="Find ${esc(FACETS[key].label.toLowerCase())}"><div class="popl"></div>
    <div class="popf"><button class="linkbtn quiet" data-none>Clear</button><span class="grow"></span><button class="btn small" data-done>Done</button></div>`;
  document.body.appendChild(pop);
  const r = btn.getBoundingClientRect();
  pop.style.left = Math.min(r.left, window.innerWidth - 380) + 'px';
  pop.style.top = r.bottom + 4 + 'px';
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
  setTimeout(() => document.addEventListener('mousedown', outside), 0);
  function outside(e) { if (!pop.contains(e.target)) closePopover(); }
  closePopover.current = () => { pop.remove(); document.removeEventListener('mousedown', outside); };
}
function closePopover() { if (closePopover.current) { closePopover.current(); closePopover.current = null; } }

// ---------- Resizable columns ----------

// Each column has a width you can drag at its right edge; widths are remembered per list.
function columns(table, key, defs) {
  let widths;
  try { widths = JSON.parse(localStorage.getItem('sift.cols.' + key)); } catch (e) { widths = null; }
  if (!Array.isArray(widths) || widths.length !== defs.length) widths = defs.map((d) => d.w);
  const apply = () => {
    const tpl = widths.map((w, i) => (i === widths.length - 1 ? `minmax(${w}px, 1fr)` : w + 'px')).join(' ');
    table.style.setProperty('--cols', tpl);
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

// ---------- Old downloads ----------

const OLD_COLS = [
  { label: '<input type="checkbox" class="check" id="allBox" title="Select all shown">', w: 22, fixed: true },
  { label: 'Name', sort: 'name', w: 260 },
  { label: 'Why it looks old', sort: 'why', w: 250 },
  { label: 'Size', sort: 'size', w: 80, num: true },
  { label: 'Last used', sort: 'touched', w: 110 },
  { label: 'From', sort: 'origin', w: 130 },
  { label: 'Folder', sort: 'dir', w: 220 },
];

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

function oldItems() {
  const st = S.old;
  let items = S.result.old.filter((o) => {
    const f = S.files.get(o.file);
    if (!f || f.kept) return false;
    if (st.onlySel && !st.sel.has(f.id)) return false;
    if (st.reasons.size && !o.signals.some((s) => st.reasons.has(s.type))) return false;
    return fileMatches(f, st.f, (x) => x.touched);
  });
  const k = st.sort.key;
  const dir = st.sort.asc ? 1 : -1;
  const val = (o) => {
    const f = S.files.get(o.file);
    return k === 'name' ? f.name.toLowerCase() : k === 'size' ? f.size : k === 'touched' ? f.touched : k === 'origin' ? f.origin || '￿' : k === 'dir' ? f.dir.toLowerCase() : o.signals.length;
  };
  items.sort((a, b) => { const x = val(a), y = val(b); return x < y ? -dir : x > y ? dir : 0; });
  return items;
}

// Rows: files, or (when grouped) a header per group followed by its files unless folded.
function oldRows() {
  const st = S.old;
  const items = oldItems();
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

function renderOld(main) {
  if (!S.result) return noResult(main, 'Old downloads');
  const st = S.old;
  const r = S.result;
  const total = r.old.reduce((a, o) => a + (S.files.get(o.file)?.size || 0), 0);
  const reasonCounts = {};
  for (const o of r.old) {
    const f = S.files.get(o.file);
    if (!f || f.kept) continue;
    for (const s of o.signals) reasonCounts[s.type] = (reasonCounts[s.type] || 0) + 1;
  }
  const reasonChips = Object.keys(REASON).filter((k) => reasonCounts[k]).map((k) =>
    `<button class="chipbtn ${st.reasons.has(k) ? 'on' : ''}" data-reason="${k}">${REASON[k].label}<span class="n">${nf.format(reasonCounts[k])}</span></button>`).join('') +
    `<span class="chipsep"></span><button class="chipbtn ${st.onlySel ? 'on' : ''}" id="onlySel" title="Show only what you selected, to look it over before removing">Only selected</button>`;
  const groupOpts = Object.entries(OLD_GROUPS).map(([k, v]) => `<option value="${k}" ${st.groupBy === k ? 'selected' : ''}>${v.label}</option>`).join('');

  main.innerHTML = header('Old downloads', `${nf.format(r.old.length)} files that look like leftovers · ${size(total)}` + fromScan(),
    `<div class="tools"><span class="slide">Group by <select id="groupBy" class="btn small">${groupOpts}</select></span>
      <button class="btn small" id="foldAll" ${st.groupBy === 'none' ? 'hidden' : ''}>Fold all</button><button class="btn small" id="unfoldAll" ${st.groupBy === 'none' ? 'hidden' : ''}>Unfold all</button></div>`) +
    filterBarHtml(st.f, 'Last used', reasonChips) + `
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
        <div title="${esc(o.signals.map((s) => REASON[s.type].tip(s)).join('\n'))}">${chips}</div>
        <div class="num">${size(f.size)}</div>
        <div class="muted" title="${esc(fullDate(f.touched))}">${ago(f.touched)}</div>
        ${originCell(f)}
        <div class="muted cellacts"><span title="${esc(f.dir)}">${esc(f.dir)}</span>${rowActions(f.id)}</div>`,
    };
  };
  const fileIds = () => rows.filter((x) => x.id !== undefined).map((x) => x.id);
  let list = virtualList(scroller, rows.length, rowHtml);
  const markMixed = () => scroller.querySelectorAll('[data-mixed]').forEach((c) => (c.indeterminate = true));
  const redraw = () => { list.redraw(); markMixed(); };
  const updateSel = wireSelbar(main, st, fileIds, () => { redraw(); updateSel(); updateAll(); }, () => confirmRecycle(st, 'old'));
  const updateAll = () => {
    const box = $('#allBox', main);
    const ids = fileIds();
    const n = ids.filter((id) => st.sel.has(id)).length;
    box.checked = ids.length > 0 && n === ids.length;
    box.indeterminate = n > 0 && n < ids.length;
  };
  const changed = () => { updateSel(); updateAll(); };
  selectionBehaviour(scroller, st, () => rows, (i) => canSelect(S.files.get(rows[i].id)), (i) => rows[i]?.id, { redraw, reveal: (i) => { list.reveal(i); markMixed(); } }, changed, () => confirmRecycle(st, 'old'));
  wireRowActions(scroller, () => render());
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
  wireFilterBar(main, st.f, oldBase, refilter);
  $('#groupBy', main).onchange = (e) => { st.groupBy = e.target.value; st.folded.clear(); render(); };
  $('#foldAll', main).onclick = () => { for (const x of rows) if (x.head) st.folded.add(x.head.key); rebuild(); };
  $('#unfoldAll', main).onclick = () => { st.folded.clear(); rebuild(); };
  $('#onlySel', main).onclick = (e) => { st.onlySel = !st.onlySel; e.target.closest('button').classList.toggle('on', st.onlySel); rebuild(); };
  main.querySelectorAll('[data-reason]').forEach((b) => (b.onclick = () => { st.reasons.has(b.dataset.reason) ? st.reasons.delete(b.dataset.reason) : st.reasons.add(b.dataset.reason); b.classList.toggle('on'); refilter(); }));
  main.querySelectorAll('[data-sort]').forEach((h) => (h.onclick = (e) => {
    if (e.target.closest('.grip')) return;
    const k = h.dataset.sort;
    if (st.sort.key === k) st.sort.asc = !st.sort.asc; else st.sort = { key: k, asc: k === 'name' || k === 'dir' || k === 'origin' || k === 'touched' };
    main.querySelectorAll('[data-sort]').forEach((x) => { x.classList.toggle('on', x.dataset.sort === st.sort.key); x.classList.toggle('asc', x.dataset.sort === st.sort.key && st.sort.asc); });
    rebuild();
  }));
  $('#allBox', main).onclick = (e) => {
    const on = e.target.checked;
    for (const id of fileIds()) on && canSelect(S.files.get(id)) ? st.sel.add(id) : st.sel.delete(id);
    redraw(); changed();
  };
}

// ---------- Duplicates ----------


const DUP_COLS = [
  { label: '', w: 22, fixed: true },
  { label: 'Name', w: 300 },
  { label: 'Folder', w: 300 },
  { label: 'Size', w: 80, num: true },
  { label: 'Changed', w: 110 },
  { label: 'From', w: 130 },
];

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
  preferred: { label: 'In a preferred folder (higher in the list wins)', score: (f) => { const l = pref('preferFolders', []); const i = l.findIndex((p) => inFolder(f, p)); return i < 0 ? 0 : l.length - i; } },
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
const DEFAULT_CHAIN = ['preferred', 'notRemoveFirst', 'nomark', 'suggested'];
const chain = () => pref('keepChain', DEFAULT_CHAIN).filter((k) => CHAIN_RULES[k]);

function pickByRules(g, rules) {
  const ids = g.files.filter((id) => S.files.has(id));
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
  newest: { label: 'newest', rules: () => ['newest'] },
  oldest: { label: 'oldest', rules: () => ['oldest'] },
  largest: { label: 'largest', rules: () => ['largest'] },
  shortest: { label: 'shortest name', rules: () => ['shortest', 'suggested'] },
  shortpath: { label: 'shortest path', rules: () => ['shortpath', 'suggested'] },
  suggested: { label: 'Sift’s pick', rules: () => ['suggested'] },
};

// In each group one file stays and the rest is selected. Kept and protected files always stay;
// when a group has one, nothing else in it needs to stay.
function keepOne(groups, pick) {
  const st = S.dupes;
  for (const g of groups) {
    const fixed = g.files.filter((id) => S.files.has(id) && !canSelect(S.files.get(id)));
    const keepId = fixed.length ? null : pick(g);
    for (const id of g.files) {
      const f = S.files.get(id);
      if (!f) continue;
      if (id === keepId || !canSelect(f)) st.sel.delete(id);
      else st.sel.add(id);
    }
  }
}
const keepAll = (groups) => { for (const g of groups) for (const id of g.files) S.dupes.sel.delete(id); };
const groupKey = (g) => g.kind + ':' + g.files.map((id) => (S.files.get(id)?.path || '').toLowerCase()).sort().join('|');

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
        ${folders('preferFolders', 'Preferred folders', 'Files here are the ones to keep. Higher in the list wins.')}
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

// A group shows when at least one of its files passes the filters; then all its files show,
// so you always see what a file is a duplicate of.
function groupsShown() {
  const st = S.dupes;
  const dismissed = new Set(pref('dismissed', []));
  let out = S.result.groups.filter((g) => {
    if (st.kinds.size ? !st.kinds.has(g.kind) : !(GROUP[g.kind].main || st.notSure)) return false;
    const fs = g.files.map((id) => S.files.get(id)).filter(Boolean);
    if (fs.length < 2) return false;
    if (!st.showDismissed && dismissed.has(groupKey(g))) return false;
    const nSel = g.files.filter((id) => st.sel.has(id)).length;
    if (st.show === 'undecided' && nSel) return false;
    if (st.show === 'selected' && !nSel) return false;
    return fs.some((f) => fileMatches(f, st.f, (x) => x.modified));
  });
  const by = st.gsort;
  if (by === 'freed') out = out.slice().sort((a, b) => freeable(b) - freeable(a));
  else if (by === 'count') out = out.slice().sort((a, b) => b.files.length - a.files.length);
  else if (by === 'name') out = out.slice().sort((a, b) => a.label.localeCompare(b.label));
  return out;
}

function freeable(g) {
  return g.files.reduce((a, id) => a + (id === g.suggested ? 0 : S.files.get(id)?.size || 0), 0);
}

function renderDupes(main) {
  if (!S.result) return noResult(main, 'Duplicates');
  const st = S.dupes;
  const r = S.result;
  const counts = {};
  for (const g of r.groups) counts[g.kind] = (counts[g.kind] || 0) + 1;
  const mainCount = r.groups.filter((g) => GROUP[g.kind].main).length;
  const notSureCount = r.groups.length - mainCount;
  const totalFree = r.groups.filter((g) => g.kind === 'copies').reduce((a, g) => a + freeable(g), 0);
  const dismissedCount = pref('dismissed', []).length;
  const chip = (k) => `<button class="chipbtn ${st.kinds.has(k) ? 'on' : ''}" data-gkind="${k}" title="${esc(GROUP[k].tip)}">${GROUP[k].label}<span class="n">${nf.format(counts[k] || 0)}</span></button>`;
  const mainKinds = Object.keys(GROUP).filter((k) => GROUP[k].main);
  const sureKinds = Object.keys(GROUP).filter((k) => !GROUP[k].main && counts[k]);
  const showChip = (k, label, tip) => `<button class="chipbtn ${st.show === k ? 'on' : ''}" data-show="${k}" title="${tip}">${label}</button>`;
  const chips = mainKinds.map(chip).join('') +
    (notSureCount ? `<span class="chipsep"></span><button class="chipbtn ${st.notSure ? 'on' : ''}" id="notSure" title="Groups that may or may not be duplicates. Hidden unless you ask.">${st.notSure ? 'Hide' : 'Show'} not sure<span class="n">${nf.format(notSureCount)}</span></button>` +
      (st.notSure || sureKinds.some((k) => st.kinds.has(k)) ? sureKinds.map(chip).join('') : '') : '') +
    `<span class="chipsep"></span>${showChip('all', 'All groups', 'Every group')}${showChip('undecided', 'Undecided', 'Groups where nothing is selected yet')}${showChip('selected', 'With a selection', 'Groups where something is selected, to look it over')}` +
    (dismissedCount ? `<span class="chipsep"></span><button class="chipbtn ${st.showDismissed ? 'on' : ''}" id="showDismissed" title="Groups you marked as not duplicates">Not duplicates<span class="n">${dismissedCount}</span></button>` : '');
  const sortOpts = [['kind', 'kind'], ['freed', 'space freed'], ['count', 'number of files'], ['name', 'name']].map(([k, l]) => `<option value="${k}" ${st.gsort === k ? 'selected' : ''}>${l}</option>`).join('');

  main.innerHTML = header('Duplicates', `${nf.format(mainCount)} groups of duplicates · the extra copies take ${size(totalFree)}` + (notSureCount ? ` · ${nf.format(notSureCount)} more groups not sure` : '') + fromScan(),
    `<div class="tools"><span class="slide">Sort groups by <select id="gsort" class="btn small">${sortOpts}</select></span></div>`) +
    `<div class="globalkeep"><span class="muted">In every group shown, keep</span>
      <button class="btn small primary" data-allrule="mine" title="${esc(chain().map((k, i) => i + 1 + '. ' + CHAIN_RULES[k].label).join('\n'))}">by my rules</button>
      <button class="btn small" id="editRules">Rules…</button>
      ${Object.entries(QUICK).filter(([k]) => k !== 'mine').map(([k, v]) => `<button class="btn small" data-allrule="${k}">${esc(v.label)}</button>`).join('')}
      <span class="muted">· or</span><button class="btn small" id="keepAllShown" title="Unselect every file in the groups shown">keep all</button>
      <span class="grow"></span><span class="muted" id="decided"></span>
      <button class="linkbtn" id="keysBtn">Keys</button></div>
    <div class="keyhelp" id="keyhelp" ${st.keys ? '' : 'hidden'}>↑ ↓ move · Space tick · J / K next or previous group · 1–9 keep that file, tick the others · A keep by my rules · U keep all in group · N not duplicates · Delete move selected to Recycle Bin</div>` +
    filterBarHtml(st.f, 'Changed', chips) + `
    <div class="table" id="table">
      <div class="thead">${headCells(DUP_COLS, st)}</div>
      <div class="scroller" id="list" tabindex="0"></div>
    </div>` + selbarHtml(st, '');
  columns($('#table', main), 'dupes', DUP_COLS);

  let groups = [];
  let rows = [];
  const build = () => {
    groups = groupsShown();
    rows = [];
    for (const g of groups) {
      rows.push({ g });
      let n = 0;
      for (const id of g.files) if (S.files.has(id)) rows.push({ g, id, n: ++n });
    }
  };
  build();
  const scroller = $('#list', main);
  const dismissed = () => new Set(pref('dismissed', []));
  const rowHtml = (i) => {
    const row = rows[i];
    const g = row.g;
    if (row.id === undefined) {
      const n = g.files.length;
      const sizes = new Set(g.files.map((id) => S.files.get(id)?.size));
      const each = sizes.size === 1 ? `${size([...sizes][0])} each` : 'different sizes';
      const nSel = g.files.filter((id) => st.sel.has(id)).length;
      const tip = g.fingerprint ? `Compared byte for byte: identical.\nFingerprint (MD5): ${g.fingerprint}` : GROUP[g.kind].tip;
      const isDismissed = st.showDismissed && dismissed().has(groupKey(g));
      return {
        cls: 'group',
        html: `<div title="${esc(tip)}"><b>${esc(GROUP[g.kind].label)}</b> · ${esc(g.label)} · ${n} files · ${each}${nSel ? ` · <span class="accentText">${nSel} selected</span>` : ''}</div>
          <div class="acts">Keep: <button class="linkbtn" data-rule="mine" data-g="${i}">my rules</button><button class="linkbtn" data-rule="newest" data-g="${i}">newest</button><button class="linkbtn" data-rule="oldest" data-g="${i}">oldest</button><button class="linkbtn" data-rule="largest" data-g="${i}">largest</button><button class="linkbtn" data-rule="all" data-g="${i}">all</button>
          <button class="linkbtn quiet" data-dismiss="${i}" title="${isDismissed ? 'Show this group as duplicates again' : 'Hide this group: these are not duplicates (remembered)'}">${isDismissed ? 'Duplicates after all' : 'Not duplicates'}</button></div>`,
      };
    }
    const f = S.files.get(row.id);
    const sel = st.sel.has(f.id);
    const tags = (f.kept ? '<span class="tag">kept</span>' : '') + (!f.kept && isProtected(f) ? '<span class="tag" title="Protected by a path pattern">protected</span>' : '') + (row.id === g.suggested && !f.kept ? `<span class="tag accent" title="The one Sift would keep">Sift’s pick</span>` : '');
    return {
      cls: `member ${sel ? 'sel' : ''} ${st.focus === i ? 'focus' : ''}`,
      html: `<div><input type="checkbox" class="check" tabindex="-1" ${sel ? 'checked' : ''} ${canSelect(f) ? '' : 'disabled'}></div>
        <div class="name" title="${esc(f.name)}">${row.n <= 9 && st.focus >= 0 && rows[st.focus]?.g === g ? `<span class="keynum">${row.n}</span>` : ''}${esc(f.name)} ${tags}</div>
        <div class="muted cellacts"><span title="${esc(f.dir)}">${esc(f.dir)}</span>${rowActions(f.id)}</div>
        <div class="num">${size(f.size)}</div>
        <div class="muted" title="${esc(fullDate(f.modified))}">${ago(f.modified)}</div>
        ${originCell(f)}`,
    };
  };
  let list = virtualList(scroller, rows.length, rowHtml);
  const visibleIds = () => rows.filter((x) => x.id !== undefined).map((x) => x.id);
  const decided = () => {
    const d = groups.filter((g) => g.files.some((id) => st.sel.has(id))).length;
    $('#decided', main).textContent = groups.length ? `${nf.format(d)} of ${nf.format(groups.length)} groups have a selection` : '';
  };
  const updateSelBase = wireSelbar(main, st, visibleIds, () => { list.redraw(); updateSel(); }, () => confirmRecycle(st, 'dupes'));
  const updateSel = () => { updateSelBase(); decided(); };
  selectionBehaviour(scroller, st, () => rows, (i) => rows[i].id !== undefined && canSelect(S.files.get(rows[i].id)), (i) => rows[i]?.id, { redraw: () => list.redraw(), reveal: (i) => list.reveal(i) }, updateSel, () => confirmRecycle(st, 'dupes'));
  wireRowActions(scroller, () => render());
  const applyQuick = (gs, rule) => {
    if (rule === 'all') keepAll(gs);
    else { const rules = QUICK[rule].rules(); keepOne(gs, (g) => pickByRules(g, rules)); }
  };
  const toggleDismiss = async (g) => {
    const l = pref('dismissed', []);
    const k = groupKey(g);
    const at = l.indexOf(k);
    if (at >= 0) l.splice(at, 1); else { l.push(k); for (const id of g.files) st.sel.delete(id); }
    await savePref('dismissed', l);
    return at < 0;
  };
  scroller.addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-rule]');
    const dm = e.target.closest('button[data-dismiss]');
    if (!b && !dm) return;
    e.stopPropagation();
    if (b) {
      applyQuick([rows[Number(b.dataset.g)].g], b.dataset.rule);
      list.redraw(); updateSel();
    } else {
      const hid = await toggleDismiss(rows[Number(dm.dataset.dismiss)].g);
      if (hid) toast('Hidden as not duplicates. “Not duplicates” in the filters shows them again.');
      render();
    }
  });
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
    else if (cur && /^[1-9]$/.test(k)) {
      const target = rows.find((x) => x.g === cur.g && x.n === Number(k));
      if (target) { keepOne([cur.g], () => target.id); list.redraw(); updateSel(); }
    } else if (cur && k === 'a') { applyQuick([cur.g], 'mine'); list.redraw(); updateSel(); }
    else if (cur && k === 'u') { keepAll([cur.g]); list.redraw(); updateSel(); }
    else if (cur && k === 'n') { await toggleDismiss(cur.g); render(); }
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
  wireFilterBar(main, st.f, dupBase, refilter);
  main.querySelectorAll('[data-gkind]').forEach((b) => (b.onclick = () => { st.kinds.has(b.dataset.gkind) ? st.kinds.delete(b.dataset.gkind) : st.kinds.add(b.dataset.gkind); b.classList.toggle('on'); refilter(); }));
  main.querySelectorAll('[data-show]').forEach((b) => (b.onclick = () => { st.show = b.dataset.show; main.querySelectorAll('[data-show]').forEach((x) => x.classList.toggle('on', x === b)); refilter(); }));
  const ns = $('#notSure', main);
  if (ns) ns.onclick = () => {
    st.notSure = !st.notSure;
    if (!st.notSure) for (const k of Object.keys(GROUP)) if (!GROUP[k].main) st.kinds.delete(k);
    render();
  };
  const sd = $('#showDismissed', main);
  if (sd) sd.onclick = () => { st.showDismissed = !st.showDismissed; render(); };
  $('#gsort', main).onchange = (e) => { st.gsort = e.target.value; refilter(); };
  $('#editRules', main).onclick = () => openRules(() => { applyQuick(groups, 'mine'); render(); toast(`Kept one file by your rules in ${nf.format(groups.length)} groups; the rest is selected.`); });
  $('#keysBtn', main).onclick = () => { st.keys = !st.keys; $('#keyhelp', main).hidden = !st.keys; scroller.focus(); };
  main.querySelectorAll('[data-allrule]').forEach((b) => (b.onclick = () => {
    applyQuick(groups, b.dataset.allrule);
    list.redraw(); updateSel();
    toast(`In ${nf.format(groups.length)} groups one file stays (${esc(QUICK[b.dataset.allrule].label)}); the rest is selected.`);
  }));
  $('#keepAllShown', main).onclick = () => { keepAll(groups); list.redraw(); updateSel(); };
}

// ---------- Recycle ----------

function reasonFor(kind, id) {
  if (kind === 'old') {
    const o = S.result.old.find((x) => x.file === id);
    return o ? o.signals.map((s) => REASON[s.type].text(s)).join(', ') : 'Old download';
  }
  const g = S.result.groups.find((x) => x.files.includes(id));
  if (!g) return 'Duplicate';
  const keepF = S.files.get(g.suggested);
  return `${GROUP[g.kind].label}${keepF && keepF.id !== id ? ' as ' + keepF.path : ''}`;
}

function confirmRecycle(st, kind) {
  const ids = [...st.sel].filter((id) => S.files.has(id) && !S.files.get(id).kept);
  if (!ids.length) return;
  const bytes = ids.reduce((a, id) => a + S.files.get(id).size, 0);
  // Duplicates are delicate: say so when every file of a group would go, from either list.
  const picked = new Set(ids);
  const whole = S.result.groups.filter((g) => g.files.length >= 2 && g.files.every((id) => picked.has(id)));
  const d = $('#confirm');
  const shown = ids;
  d.innerHTML = `<div class="dh"><h2>Move ${nf.format(ids.length)} file${ids.length === 1 ? '' : 's'} to the Recycle Bin?</h2>
      <p>${size(bytes)}. You can put them back from History or from the Recycle Bin.</p></div>
    ${whole.length ? `<div class="warnbox">In ${whole.length} duplicate group${whole.length === 1 ? '' : 's'} every file is selected, so none of that file stays: ${whole.slice(0, 3).map((g) => '“' + esc(g.label) + '”').join(', ')}${whole.length > 3 ? '…' : ''}</div>` : ''}
    <div class="dl">${shown.map((id) => { const f = S.files.get(id); return `<div><span class="n" title="${esc(f.path)}">${esc(f.path)}</span><span class="s">${size(f.size)}</span></div>`; }).join('')}
</div>
    <div class="df"><button class="btn" id="dCancel">Cancel</button><button class="btn danger" id="dGo">Move to Recycle Bin</button></div>`;
  d.showModal();
  $('#dCancel', d).focus();
  $('#dCancel', d).onclick = () => d.close();
  $('#dGo', d).onclick = async () => {
    $('#dGo', d).disabled = true;
    $('#dGo', d).textContent = 'Moving…';
    try {
      const items = ids.map((id) => ({ path: S.files.get(id).path, reason: reasonFor(kind, id) }));
      const out = await invoke('recycle', { items });
      d.close();
      await loadResult();
      await loadOverview();
      render();
      const movedSet = new Set(out.moved.map((p) => p.toLowerCase()));
      const removalIds = S.overview.removals.filter((x) => !x.restoredAt && movedSet.has(x.path.toLowerCase())).map((x) => x.id);
      const msg = `${nf.format(out.moved.length)} moved to the Recycle Bin.` + (out.failed.length ? ` ${out.failed.length} could not be moved: ${esc(out.failed[0].error)}` : '');
      toast(msg, out.moved.length && S.overview.canPutBack ? { label: 'Undo', run: () => putBack(removalIds) } : null);
    } catch (e) {
      d.close();
      fail(e);
    }
  };
}

async function putBack(ids) {
  let ok = 0, bad = [];
  for (const id of ids) {
    try { await invoke('put_back', { id }); ok++; } catch (e) { bad.push(String(e)); }
  }
  await loadOverview();
  render();
  toast(`${nf.format(ok)} put back.` + (bad.length ? ` ${bad.length} could not: ${esc(bad[0])}` : '') + (ok ? ' Scan again to see them in the lists.' : ''));
}

// ---------- Where to look ----------

// ---------- Step 1: Scan (where to look, what counts, then scan) ----------

function sliderRow(it) {
  const v = setting(it.key);
  return `<div class="setting"><div class="t">${it.title}</div><div class="d">${it.desc}</div>
    <div class="ctl"><input type="range" data-key="${it.key}" min="${it.min}" max="${it.max}" value="${it.toUi(v)}"><output>${esc(it.label(v))}</output></div></div>`;
}

function renderScan(main) {
  const o = S.overview;
  const r = S.result;
  const on = o.folders.filter((f) => f.enabled).length;
  main.innerHTML = header('Scan', 'Choose where Sift looks and what counts, then scan. Sift only looks when you press Scan.') + `<div class="page">
    <div class="card"><h2><span class="num">a</span>Where to look</h2><p class="hint">Untick a folder to leave it out without forgetting it.</p>
      <div class="list" id="folders">${o.folders.length ? o.folders.map((f, i) => `<div class="li ${f.enabled ? '' : 'off'}">
        <input type="checkbox" class="check" data-fi="${i}" ${f.enabled ? 'checked' : ''} title="Look in this folder">
        <span class="p" title="${esc(f.path)}">${esc(f.path)}</span>
        <button class="linkbtn quiet" data-show="${i}">Show</button><button class="linkbtn quiet" data-remove="${i}">Remove</button></div>`).join('') : '<div class="empty-list">No folders yet.</div>'}</div>
      <div class="addrow"><button class="btn" id="addFolder">Add a folder…</button></div>
      <details class="skip" ${S.skipOpen ? 'open' : ''}><summary>Never look in (${o.skip.length})</summary>
        <p class="hint">Folders and patterns Sift skips. Use * for anything, like <b>*\\Steam\\*</b> or <b>*.tmp</b>.</p>
        <div class="list">${o.skip.length ? o.skip.map((p, i) => `<div class="li"><span class="p">${esc(p)}</span><button class="linkbtn quiet" data-unskip="${i}">Remove</button></div>`).join('') : '<div class="empty-list">Nothing skipped.</div>'}</div>
        <div class="addrow"><input id="skipIn" placeholder="A folder path or a pattern"><button class="btn" id="addSkip">Add</button></div>
      </details></div>

    ${SETTINGS.map((sec, i) => `<div class="card"><h2><span class="num">${'bc'[i]}</span>${sec.section}</h2>${sec.items.map(sliderRow).join('')}</div>`).join('')}

    <div class="card"><h2><span class="num">d</span>Scan</h2>
      <div class="scanpanel" id="scanState">
        <button class="btn primary big" id="scanGo" ${on ? '' : 'disabled'}>Scan</button>
        <div class="state"><div id="scanStateText"></div><div id="scanPageBar" class="bar" hidden><i></i></div></div>
        <button class="linkbtn quiet" id="resetSliders" title="Put every slider back where Sift started">Reset sliders</button>
      </div>
      ${on ? '' : '<p class="hint">Tick or add a folder first.</p>'}
      ${r && !S.scanning ? `<div class="resultlinks"><button class="btn" data-go="old">See ${nf.format(r.old.length)} old downloads →</button><button class="btn" data-go="dupes">See ${nf.format(r.groups.filter((g) => GROUP[g.kind].main).length)} groups of duplicates →</button></div>` : ''}
    </div>
  </div>`;
  renderSide();
  const reload = async () => { await loadOverview(); render(); };
  $('#scanGo', main).onclick = async () => {
    const was = S.scanning;
    await scanOrStop();
    if (!was && !S.scanning && S.result) go('scan');
  };
  main.querySelectorAll('[data-go]').forEach((b) => (b.onclick = () => go(b.dataset.go)));
  $('details.skip', main).ontoggle = (e) => { S.skipOpen = e.target.open; };
  $('#addFolder', main).onclick = async () => {
    try {
      const p = await invoke('pick_folder');
      if (p) { await invoke('add_folder', { path: p }); reload(); }
    } catch (e) { fail(e); }
  };
  main.querySelectorAll('[data-fi]').forEach((b) => (b.onchange = async () => { await invoke('set_folder_enabled', { path: o.folders[b.dataset.fi].path, enabled: b.checked }).catch(fail); reload(); }));
  main.querySelectorAll('[data-show]').forEach((b) => (b.onclick = () => invoke('open_file', { path: o.folders[b.dataset.show].path }).catch(fail)));
  main.querySelectorAll('[data-remove]').forEach((b) => (b.onclick = async () => { await invoke('remove_folder', { path: o.folders[b.dataset.remove].path }).catch(fail); reload(); }));
  main.querySelectorAll('[data-unskip]').forEach((b) => (b.onclick = async () => { await invoke('remove_skip', { pattern: o.skip[b.dataset.unskip] }).catch(fail); reload(); }));
  const addSkip = async () => {
    const v = $('#skipIn', main).value.trim();
    if (!v) return;
    await invoke('add_skip', { pattern: v }).catch(fail);
    reload();
  };
  $('#addSkip', main).onclick = addSkip;
  $('#skipIn', main).onkeydown = (e) => { if (e.key === 'Enter') addSkip(); };
  const all = SETTINGS.flatMap((x) => x.items);
  main.querySelectorAll('input[data-key]').forEach((inp) => {
    const it = all.find((x) => x.key === inp.dataset.key);
    inp.oninput = () => { inp.nextElementSibling.textContent = it.label(it.fromUi(Number(inp.value))); };
    inp.onchange = async () => {
      const v = it.fromUi(Number(inp.value));
      await invoke('set_setting', { key: it.key, value: String(v) }).catch(fail);
      S.overview.settings[it.key] = String(v);
    };
  });
  $('#resetSliders', main).onclick = async () => {
    for (const [k, v] of Object.entries(DEFAULTS)) await invoke('set_setting', { key: k, value: String(v) }).catch(fail);
    reload();
  };
}

// ---------- Kept and protected ----------

function renderKept(main) {
  const o = S.overview;
  main.innerHTML = header('Kept and protected', 'Files Sift never suggests for removal.') + `<div class="page">
    <div class="card"><h2>Protected paths</h2><p class="hint">Files whose path matches one of these can never be selected. Use * for anything, like <b>*\\Photos\\*</b>.</p>
      <div class="list">${pref('protect', []).length ? pref('protect', []).map((p, i) => `<div class="li"><span class="p">${esc(p)}</span><button class="linkbtn quiet" data-unprotect="${i}">Remove</button></div>`).join('') : '<div class="empty-list">Nothing protected.</div>'}</div>
      <div class="addrow"><input id="protIn" placeholder="A path or a pattern"><button class="btn" id="addProt">Add</button></div></div>
    <div class="card"><h2>Kept files</h2><p class="hint">Files you chose to keep with Keep in the lists.</p>
      <div class="list">${o.kept.length ? o.kept.slice(0, 500).map((k, i) => `<div class="li"><span class="p" title="${esc(k.path)}">${esc(k.path)}</span><span class="m">${ago(k.at)}</span><button class="linkbtn quiet" data-unkeep="${i}">Stop keeping</button></div>`).join('') : '<div class="empty-list">None yet.</div>'}</div></div>
  </div>`;
  main.querySelectorAll('[data-unkeep]').forEach((b) => (b.onclick = async () => {
    await invoke('unkeep', { paths: [o.kept[b.dataset.unkeep].path] }).catch(fail);
    await loadResult();
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

// ---------- History ----------

function renderHistory(main) {
  const o = S.overview;
  const rem = o.removals;
  const freed = rem.filter((x) => !x.restoredAt).reduce((a, x) => a + x.size, 0);
  main.innerHTML = header('History', `${nf.format(rem.length)} files moved to the Recycle Bin · ${size(freed)}`) + `<div class="page">
    <div class="card"><h2>Moved to the Recycle Bin</h2><p class="hint">Newest first. Put back returns a file to where it was, as long as it is still in the Recycle Bin.</p>
      <div class="list">${rem.length ? rem.slice(0, 1000).map((x) => `<div class="li">
        <span class="p" title="${esc(x.path)}\n${esc(x.reason)}">${esc(x.path)}</span>
        <span class="m" title="${esc(fullDate(x.at))}">${size(x.size)} · ${ago(x.at)}</span>
        ${x.restoredAt ? '<span class="tag">put back</span>' : o.canPutBack ? `<button class="linkbtn" data-back="${x.id}">Put back</button>` : ''}</div>`).join('') : '<div class="empty-list">Nothing moved yet.</div>'}</div></div>
    <div class="card"><h2>Scans</h2>
      <div class="list">${o.scans.length ? o.scans.map((s) => `<div class="li">
        <span class="p" title="${esc(s.folders)}">${esc(fullDate(s.startedAt))}${s.cancelled ? ' <span class="tag">stopped</span>' : ''}</span>
        <span class="m">${nf.format(s.filesSeen)} files · ${size(s.bytesSeen)} · ${nf.format(s.oldCount)} old · ${nf.format(s.groupCount)} duplicate groups</span></div>`).join('') : '<div class="empty-list">No scans yet.</div>'}</div></div>
  </div>`;
  main.querySelectorAll('[data-back]').forEach((b) => (b.onclick = () => putBack([Number(b.dataset.back)])));
}

// ---------- What counts (sliders, shown in step 1) ----------

const MIN_DUPE_STEPS = [0, 1024, 10240, 102400, 1 << 20, 10 << 20, 100 << 20];

const SETTINGS = [
  { section: 'What counts as an old download', items: [
    { key: 'untouchedMonths', title: 'Unused for at least', desc: 'A file nobody opened or changed for this long counts as old.', min: 1, max: 36, toUi: (v) => v, fromUi: (u) => u, label: (v) => `${v} month${v === 1 ? '' : 's'}` },
    { key: 'archiveMonths', title: 'Archives older than', desc: 'Zip, 7z and rar files older than this count as old, even if opened lately.', min: 1, max: 24, toUi: (v) => v, fromUi: (u) => u, label: (v) => `${v} month${v === 1 ? '' : 's'}` },
  ] },
  { section: 'What counts as a duplicate', items: [
    { key: 'minDupeSize', title: 'Leave out files smaller than', desc: 'Tiny files are rarely worth the time.', min: 0, max: MIN_DUPE_STEPS.length - 1, toUi: (v) => Math.max(0, MIN_DUPE_STEPS.indexOf(v)), fromUi: (u) => MIN_DUPE_STEPS[u], label: (v) => (v ? size(v) : 'Include all') },
    { key: 'similarNames', title: 'Similar names: how alike', desc: 'How close two names must be to show as “similar names”. Lower finds more, and more that are not really the same.', min: 79, max: 99, toUi: (v) => (v ? v : 79), fromUi: (u) => (u === 79 ? 0 : u), label: (v) => (v ? v + '%' : 'Off') },
  ] },
];

// ---------- Start ----------

async function start() {
  document.querySelectorAll('.navitem').forEach((b) => (b.onclick = () => go(b.dataset.view)));
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) {
      const q = $('#q');
      if (q) { e.preventDefault(); q.focus(); q.select(); }
    }
  });
  await T.event.listen('scan-progress', (ev) => { S.progress = ev.payload; renderSide(); });
  try {
    await loadOverview();
    await loadResult();
  } catch (e) { fail(e); }
  if (!S.result) S.view = 'scan';
  render();
}

start();
