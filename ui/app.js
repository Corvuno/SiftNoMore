// Sift's window. Plain JavaScript, no framework: one state object, pages drawn from it, long
// lists drawn only where they are visible so tens of thousands of files stay smooth.
'use strict';

const T = window.__TAURI__;
const invoke = (cmd, args) => T.core.invoke(cmd, args);

// ---------- State ----------

const DEFAULTS = { untouchedMonths: 6, archiveMonths: 3, minDupeSize: 1024, similarNames: 90 };

const S = {
  view: 'old',
  overview: null,
  result: null,
  files: new Map(),
  scanning: false,
  progress: null,
  old: { query: '', kinds: new Set(), reasons: new Set(), minSize: 0, sort: { key: 'size', asc: false }, sel: new Set(), focus: -1, anchor: -1 },
  dupes: { query: '', kinds: new Set(), minSize: 0, sel: new Set(), focus: -1, anchor: -1, keepRule: 'suggested' },
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
  unpacked: { label: 'Already unpacked', text: () => 'Already unpacked', tip: (s) => `Its contents are in ${s.folder}` },
  oldArchive: { label: 'Old archive', text: (s) => `Archive, ${s.months} months old`, tip: () => 'An archive older than the limit in Settings' },
  superseded: { label: 'Newer version here', text: () => 'Newer version here', tip: (s) => `A newer version is here: ${s.newer}` },
};

const GROUP = {
  sameContent: { label: 'Same content', tip: 'Byte for byte the same file' },
  copies: { label: 'Copies', tip: 'Names with a copy mark, like “(1)” or “- Copy”' },
  versions: { label: 'Versions', tip: 'Different versions of the same thing' },
  sameName: { label: 'Same name', tip: 'The same name in different folders, different content' },
  similarName: { label: 'Similar names', tip: 'Names that are nearly the same' },
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

// ---------- Loading ----------

async function loadOverview() {
  S.overview = await invoke('overview');
}

function setResult(r) {
  S.result = r;
  S.files = new Map(r ? r.files.map((f) => [f.id, f]) : []);
  for (const st of [S.old, S.dupes]) {
    for (const id of [...st.sel]) if (!S.files.has(id) || S.files.get(id).kept) st.sel.delete(id);
    st.focus = -1;
  }
}

async function loadResult() {
  const json = await invoke('last_result');
  setResult(json ? JSON.parse(json) : null);
}

// ---------- Sidebar ----------

function renderSide() {
  document.querySelectorAll('.navitem').forEach((b) => b.classList.toggle('on', b.dataset.view === S.view));
  const r = S.result;
  $('#countOld').textContent = r ? nf.format(r.old.length) : '';
  $('#countDupes').textContent = r ? nf.format(r.groups.length) : '';
  const btn = $('#scanBtn');
  const info = $('#scanInfo');
  const bar = $('#scanBar');
  if (S.scanning) {
    btn.textContent = 'Stop';
    btn.classList.remove('primary');
    bar.hidden = false;
    const p = S.progress;
    if (!p || p.phase === 'looking') {
      info.textContent = p ? `Looking… ${nf.format(p.files)} files` : 'Starting…';
      bar.classList.add('busy');
    } else if (p.phase === 'comparing') {
      const pct = p.total ? Math.min(100, Math.round((p.done / p.total) * 100)) : 100;
      info.textContent = `Comparing contents… ${pct}%`;
      bar.classList.remove('busy');
      bar.firstElementChild.style.width = pct + '%';
    } else {
      info.textContent = 'Checking what is old…';
      bar.classList.add('busy');
    }
  } else {
    btn.textContent = r ? 'Scan again' : 'Scan now';
    btn.classList.add('primary');
    bar.hidden = true;
    bar.classList.remove('busy');
    info.textContent = r ? `Last scan ${ago(r.finishedAt)}` : 'Not scanned yet';
    info.title = r ? fullDate(r.finishedAt) : '';
  }
}

async function scanOrStop() {
  if (S.scanning) {
    invoke('cancel_scan');
    return;
  }
  const enabled = (S.overview.folders || []).filter((f) => f.enabled);
  if (!enabled.length) {
    go('folders');
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
  S.view = view;
  render();
}

function render() {
  renderSide();
  const main = $('#main');
  main.innerHTML = '';
  ({ old: renderOld, dupes: renderDupes, folders: renderFolders, history: renderHistory, settings: renderSettings })[S.view](main);
}

const SEARCH_ICON = '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/></svg>';

function header(title, sub, extra = '') {
  return `<div class="head"><div><h1>${esc(title)}</h1><div class="sub">${sub}</div></div><div class="grow"></div>${extra}</div>`;
}

function noResult(main, title) {
  main.innerHTML = header(title, '') + `<div class="page"><div class="empty"><h2>Nothing scanned yet</h2>
    <p>Sift looks in the folders under Where to look. Your Downloads folder is there already.</p>
    <button class="btn primary" id="emptyScan">Scan now</button> <button class="btn" id="emptyFolders">Where to look</button></div></div>`;
  $('#emptyScan').onclick = scanOrStop;
  $('#emptyFolders').onclick = () => go('folders');
}

// Size filter steps, shared by both result pages.
const SIZE_STEPS = [0, 1 << 20, 10 << 20, 50 << 20, 100 << 20, 500 << 20, 1 << 30];
const sizeStepLabel = (i) => (i === 0 ? 'Any size' : '≥ ' + size(SIZE_STEPS[i]));

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
    <div class="pattern" title="Select files by path, with * for anything. For example: *\\Downloads\\old\\*">
      <input id="patIn" placeholder="Select by path, like *\\Old\\*">
      <button class="btn small" id="patSel">Select</button><button class="btn small" id="patUnsel">Unselect</button>
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
  $('#selKeep', main).onclick = () => keepFiles([...st.sel], () => render());
  $('#selRecycle', main).onclick = recycleFn;
  const applyPattern = (on) => {
    const re = patternRegex($('#patIn', main).value);
    if (!re) return;
    let n = 0;
    for (const id of visibleIds()) {
      const f = S.files.get(id);
      if (f && !f.kept && re.test(f.path)) { on ? st.sel.add(id) : st.sel.delete(id); n++; }
    }
    toast(n ? `${on ? 'Selected' : 'Unselected'} ${nf.format(n)} files matching that path.` : 'No file shown here matches that path.');
    refresh();
  };
  $('#patSel', main).onclick = () => applyPattern(true);
  $('#patUnsel', main).onclick = () => applyPattern(false);
  $('#patIn', main).onkeydown = (e) => { if (e.key === 'Enter') applyPattern(true); };
  return update;
}

// ---------- Old downloads ----------

function oldRows() {
  const st = S.old;
  const q = st.query.trim().toLowerCase();
  const min = SIZE_STEPS[st.minSize];
  let rows = S.result.old.filter((o) => {
    const f = S.files.get(o.file);
    if (!f || f.kept) return false;
    if (q && !f.path.toLowerCase().includes(q)) return false;
    if (st.kinds.size && !st.kinds.has(f.kind)) return false;
    if (st.reasons.size && !o.signals.some((s) => st.reasons.has(s.type))) return false;
    if (f.size < min) return false;
    return true;
  });
  const k = st.sort.key;
  const dir = st.sort.asc ? 1 : -1;
  const val = (o) => {
    const f = S.files.get(o.file);
    return k === 'name' ? f.name.toLowerCase() : k === 'size' ? f.size : k === 'touched' ? f.touched : k === 'origin' ? f.origin || '￿' : k === 'dir' ? f.dir.toLowerCase() : o.signals.length;
  };
  rows.sort((a, b) => { const x = val(a), y = val(b); return x < y ? -dir : x > y ? dir : 0; });
  return rows;
}

function renderOld(main) {
  if (!S.result) return noResult(main, 'Old downloads');
  const st = S.old;
  const r = S.result;
  const total = r.old.reduce((a, o) => a + (S.files.get(o.file)?.size || 0), 0);
  const kindCounts = {};
  const reasonCounts = {};
  for (const o of r.old) {
    const f = S.files.get(o.file);
    if (!f || f.kept) continue;
    kindCounts[f.kind] = (kindCounts[f.kind] || 0) + 1;
    for (const s of o.signals) reasonCounts[s.type] = (reasonCounts[s.type] || 0) + 1;
  }
  const kindChips = Object.keys(KIND_LABEL).filter((k) => kindCounts[k]).map((k) =>
    `<button class="chipbtn ${st.kinds.has(k) ? 'on' : ''}" data-kind="${k}">${KIND_LABEL[k]}<span class="n">${nf.format(kindCounts[k])}</span></button>`).join('');
  const reasonChips = Object.keys(REASON).filter((k) => reasonCounts[k]).map((k) =>
    `<button class="chipbtn ${st.reasons.has(k) ? 'on' : ''}" data-reason="${k}">${REASON[k].label}<span class="n">${nf.format(reasonCounts[k])}</span></button>`).join('');

  const sortCol = (key, label, cls = '') =>
    `<div class="sort ${cls} ${st.sort.key === key ? 'on' : ''} ${st.sort.key === key && st.sort.asc ? 'asc' : ''}" data-sort="${key}">${label}</div>`;

  main.innerHTML = header('Old downloads', `${nf.format(r.old.length)} files that look like leftovers · ${size(total)}`) + `
    <div class="filters">
      <label class="search">${SEARCH_ICON}<input id="q" placeholder="Search name or folder" value="${esc(st.query)}"></label>
      <div class="chips">${reasonChips}</div>
    </div>
    <div class="filters" style="padding-top:0"><div class="chips">${kindChips}</div>
      <div class="slide">Size <input type="range" id="minSize" min="0" max="${SIZE_STEPS.length - 1}" value="${st.minSize}"><output id="minSizeOut">${sizeStepLabel(st.minSize)}</output></div></div>
    <div class="table">
      <div class="thead cols-old"><div><input type="checkbox" class="check" id="allBox" title="Select all shown"></div>
        ${sortCol('name', 'Name')}${sortCol('why', 'Why it looks old')}${sortCol('size', 'Size', 'num')}${sortCol('touched', 'Last used')}${sortCol('origin', 'From')}${sortCol('dir', 'Folder')}</div>
      <div class="scroller" id="list" tabindex="0"></div>
    </div>` + selbarHtml(st, '');

  let rows = oldRows();
  const scroller = $('#list', main);
  const rowHtml = (i) => {
    const o = rows[i];
    const f = S.files.get(o.file);
    const sel = st.sel.has(f.id);
    const chips = [...o.signals].sort((x, y) => (x.type === 'untouched' || x.type === 'oldArchive') - (y.type === 'untouched' || y.type === 'oldArchive')).map((s) => `<span class="tag ${s.type === 'untouched' || s.type === 'oldArchive' ? '' : 'accent'}">${esc(REASON[s.type].text(s))}</span>`).join('');
    return {
      cls: `cols-old ${sel ? 'sel' : ''} ${st.focus === i ? 'focus' : ''}`,
      html: `<div><input type="checkbox" class="check" tabindex="-1" ${sel ? 'checked' : ''}></div>
        <div class="name" title="${esc(f.name)}">${esc(f.name)}</div>
        <div title="${esc(o.signals.map((s) => REASON[s.type].tip(s)).join('\n'))}">${chips}</div>
        <div class="num">${size(f.size)}</div>
        <div class="muted" title="${esc(fullDate(f.touched))}">${ago(f.touched)}</div>
        <div class="muted" title="${esc(f.origin || 'Where it came from is not known')}">${esc(f.origin || '—')}</div>
        <div class="muted" style="display:flex;gap:6px;align-items:center"><span style="overflow:hidden;text-overflow:ellipsis" title="${esc(f.dir)}">${esc(f.dir)}</span>${rowActions(f.id)}</div>`,
    };
  };
  let list = virtualList(scroller, rows.length, rowHtml);
  const updateSel = wireSelbar(main, st, () => rows.map((o) => o.file), () => { list.redraw(); updateSel(); updateAll(); }, () => confirmRecycle(st, 'old'));
  const updateAll = () => {
    const box = $('#allBox', main);
    const n = rows.filter((o) => st.sel.has(o.file)).length;
    box.checked = rows.length > 0 && n === rows.length;
    box.indeterminate = n > 0 && n < rows.length;
  };
  const changed = () => { updateSel(); updateAll(); };
  selectionBehaviour(scroller, st, () => rows, () => true, (i) => rows[i]?.file, { redraw: () => list.redraw(), reveal: (i) => list.reveal(i) }, changed, () => confirmRecycle(st, 'old'));
  wireRowActions(scroller, () => render());
  changed();
  if (!rows.length) scroller.innerHTML = '<div class="empty"><h2>Nothing here</h2><p>No file matches these filters.</p></div>';

  const refilter = () => {
    rows = oldRows();
    st.focus = -1;
    list = virtualList(scroller, rows.length, rowHtml);
    if (!rows.length) scroller.innerHTML = '<div class="empty"><h2>Nothing here</h2><p>No file matches these filters.</p></div>';
    changed();
  };
  $('#q', main).oninput = (e) => { st.query = e.target.value; refilter(); };
  $('#minSize', main).oninput = (e) => { st.minSize = Number(e.target.value); $('#minSizeOut', main).textContent = sizeStepLabel(st.minSize); refilter(); };
  main.querySelectorAll('[data-kind]').forEach((b) => (b.onclick = () => { st.kinds.has(b.dataset.kind) ? st.kinds.delete(b.dataset.kind) : st.kinds.add(b.dataset.kind); b.classList.toggle('on'); refilter(); }));
  main.querySelectorAll('[data-reason]').forEach((b) => (b.onclick = () => { st.reasons.has(b.dataset.reason) ? st.reasons.delete(b.dataset.reason) : st.reasons.add(b.dataset.reason); b.classList.toggle('on'); refilter(); }));
  main.querySelectorAll('[data-sort]').forEach((h) => (h.onclick = () => {
    const k = h.dataset.sort;
    if (st.sort.key === k) st.sort.asc = !st.sort.asc; else st.sort = { key: k, asc: k === 'name' || k === 'dir' || k === 'origin' || k === 'touched' };
    main.querySelectorAll('[data-sort]').forEach((x) => { x.classList.toggle('on', x.dataset.sort === st.sort.key); x.classList.toggle('asc', x.dataset.sort === st.sort.key && st.sort.asc); });
    refilter();
  }));
  $('#allBox', main).onclick = (e) => {
    const on = e.target.checked;
    for (const o of rows) on ? st.sel.add(o.file) : st.sel.delete(o.file);
    list.redraw(); changed();
  };
}

// ---------- Duplicates ----------

const KEEP_RULES = {
  suggested: { label: 'Sift’s pick', pick: (g) => g.suggested },
  newest: { label: 'newest', pick: (g) => maxBy(g.files, (id) => S.files.get(id).modified) },
  oldest: { label: 'oldest', pick: (g) => maxBy(g.files, (id) => -S.files.get(id).modified) },
  largest: { label: 'largest', pick: (g) => maxBy(g.files, (id) => S.files.get(id).size) },
  shortest: { label: 'shortest name', pick: (g) => maxBy(g.files, (id) => -S.files.get(id).name.length) },
};

function maxBy(ids, f) {
  let best = ids[0], bv = -Infinity;
  for (const id of ids) { const v = f(id); if (v > bv) { bv = v; best = id; } }
  return best;
}

function groupsShown() {
  const st = S.dupes;
  const q = st.query.trim().toLowerCase();
  const min = SIZE_STEPS[st.minSize];
  return S.result.groups.filter((g) => {
    if (st.kinds.size && !st.kinds.has(g.kind)) return false;
    const fs = g.files.map((id) => S.files.get(id)).filter(Boolean);
    if (fs.length < 2) return false;
    if (q && !fs.some((f) => f.path.toLowerCase().includes(q))) return false;
    if (min && !fs.some((f) => f.size >= min)) return false;
    return true;
  });
}

function freeable(g) {
  return g.files.reduce((a, id) => a + (id === g.suggested ? 0 : S.files.get(id)?.size || 0), 0);
}

// In each group: select everything except the one the rule keeps (never a kept file).
function applyKeepRule(groups, rule) {
  const st = S.dupes;
  for (const g of groups) {
    const kept = g.files.filter((id) => S.files.get(id)?.kept);
    const keepId = kept.length ? kept[0] : KEEP_RULES[rule].pick(g);
    for (const id of g.files) {
      if (id === keepId || S.files.get(id)?.kept) st.sel.delete(id);
      else st.sel.add(id);
    }
  }
}

function renderDupes(main) {
  if (!S.result) return noResult(main, 'Duplicates');
  const st = S.dupes;
  const r = S.result;
  const counts = {};
  for (const g of r.groups) counts[g.kind] = (counts[g.kind] || 0) + 1;
  const totalFree = r.groups.filter((g) => g.kind === 'sameContent').reduce((a, g) => a + freeable(g), 0);
  const chips = Object.keys(GROUP).filter((k) => counts[k]).map((k) =>
    `<button class="chipbtn ${st.kinds.has(k) ? 'on' : ''}" data-gkind="${k}" title="${esc(GROUP[k].tip)}">${GROUP[k].label}<span class="n">${nf.format(counts[k])}</span></button>`).join('');
  const ruleOpts = Object.entries(KEEP_RULES).map(([k, v]) => `<option value="${k}" ${st.keepRule === k ? 'selected' : ''}>${esc(v.label)}</option>`).join('');

  main.innerHTML = header('Duplicates', `${nf.format(r.groups.length)} groups · byte-for-byte copies alone take ${size(totalFree)}`,
    `<div class="tools"><span class="slide">Keep in every group shown: <select id="rule" class="btn small">${ruleOpts}</select></span><button class="btn" id="applyRule">Select the rest</button>
      <button class="btn" id="acceptExact" title="In every same-content group, select all copies but one">Select all exact copies</button></div>`) + `
    <div class="filters">
      <label class="search">${SEARCH_ICON}<input id="q" placeholder="Search name or folder" value="${esc(st.query)}"></label>
      <div class="chips">${chips}</div>
      <div class="slide">Size <input type="range" id="minSize" min="0" max="${SIZE_STEPS.length - 1}" value="${st.minSize}"><output id="minSizeOut">${sizeStepLabel(st.minSize)}</output></div>
    </div>
    <div class="table">
      <div class="thead cols-dup"><div></div><div>Name</div><div>Folder</div><div class="num">Size</div><div>Changed</div><div>From</div></div>
      <div class="scroller" id="list" tabindex="0"></div>
    </div>` + selbarHtml(st, '');

  let groups = [];
  let rows = [];
  const build = () => {
    groups = groupsShown();
    rows = [];
    for (const g of groups) {
      rows.push({ g });
      for (const id of g.files) if (S.files.has(id)) rows.push({ g, id });
    }
  };
  build();
  const scroller = $('#list', main);
  const rowHtml = (i) => {
    const row = rows[i];
    const g = row.g;
    if (row.id === undefined) {
      const n = g.files.length;
      const sizes = new Set(g.files.map((id) => S.files.get(id)?.size));
      const each = g.kind === 'sameContent' ? `${size(S.files.get(g.files[0]).size)} each` : sizes.size === 1 ? `${size([...sizes][0])} each` : 'different sizes';
      return {
        cls: 'group',
        html: `<div><b>${esc(GROUP[g.kind].label)}</b> · ${esc(g.label)} · ${n} files · ${each}</div>
          <div class="acts">Keep: ${Object.entries(KEEP_RULES).map(([k, v]) => `<button class="linkbtn" data-rule="${k}" data-g="${i}">${esc(v.label)}</button>`).join('')}</div>`,
      };
    }
    const f = S.files.get(row.id);
    const sel = st.sel.has(f.id);
    const tags = (f.kept ? '<span class="tag">kept</span>' : '') + (row.id === g.suggested && !f.kept ? `<span class="tag accent" title="The one Sift would keep">Sift’s pick</span>` : '');
    return {
      cls: `member cols-dup ${sel ? 'sel' : ''} ${st.focus === i ? 'focus' : ''}`,
      html: `<div><input type="checkbox" class="check" tabindex="-1" ${sel ? 'checked' : ''} ${f.kept ? 'disabled' : ''}></div>
        <div class="name" title="${esc(f.name)}">${esc(f.name)} ${tags}</div>
        <div class="muted" style="display:flex;gap:6px;align-items:center"><span style="overflow:hidden;text-overflow:ellipsis" title="${esc(f.dir)}">${esc(f.dir)}</span>${rowActions(f.id)}</div>
        <div class="num">${size(f.size)}</div>
        <div class="muted" title="${esc(fullDate(f.modified))}">${ago(f.modified)}</div>
        <div class="muted">${esc(f.origin || '—')}</div>`,
    };
  };
  let list = virtualList(scroller, rows.length, rowHtml);
  const visibleIds = () => rows.filter((x) => x.id !== undefined).map((x) => x.id);
  const updateSel = wireSelbar(main, st, visibleIds, () => { list.redraw(); updateSel(); }, () => confirmRecycle(st, 'dupes'));
  selectionBehaviour(scroller, st, () => rows, (i) => rows[i].id !== undefined && !S.files.get(rows[i].id).kept, (i) => rows[i]?.id, { redraw: () => list.redraw(), reveal: (i) => list.reveal(i) }, updateSel, () => confirmRecycle(st, 'dupes'));
  wireRowActions(scroller, () => render());
  scroller.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-rule]');
    if (!b) return;
    e.stopPropagation();
    applyKeepRule([rows[Number(b.dataset.g)].g], b.dataset.rule);
    list.redraw(); updateSel();
  });
  updateSel();
  const empty = () => { if (!rows.length) scroller.innerHTML = '<div class="empty"><h2>Nothing here</h2><p>No group matches these filters.</p></div>'; };
  empty();

  const refilter = () => { build(); st.focus = -1; list = virtualList(scroller, rows.length, rowHtml); empty(); updateSel(); };
  $('#q', main).oninput = (e) => { st.query = e.target.value; refilter(); };
  $('#minSize', main).oninput = (e) => { st.minSize = Number(e.target.value); $('#minSizeOut', main).textContent = sizeStepLabel(st.minSize); refilter(); };
  main.querySelectorAll('[data-gkind]').forEach((b) => (b.onclick = () => { st.kinds.has(b.dataset.gkind) ? st.kinds.delete(b.dataset.gkind) : st.kinds.add(b.dataset.gkind); b.classList.toggle('on'); refilter(); }));
  $('#rule', main).onchange = (e) => { st.keepRule = e.target.value; };
  $('#applyRule', main).onclick = () => { applyKeepRule(groups, st.keepRule); list.redraw(); updateSel(); toast(`Selected all but one in ${nf.format(groups.length)} groups.`); };
  $('#acceptExact', main).onclick = () => {
    const exact = groupsShown().filter((g) => g.kind === 'sameContent');
    applyKeepRule(exact, 'suggested');
    list.redraw(); updateSel();
    toast(exact.length ? `Selected the extra copies in ${nf.format(exact.length)} same-content groups. One of each stays.` : 'No same-content groups shown.');
  };
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
  const shown = ids.slice(0, 300);
  d.innerHTML = `<div class="dh"><h2>Move ${nf.format(ids.length)} file${ids.length === 1 ? '' : 's'} to the Recycle Bin?</h2>
      <p>${size(bytes)}. You can put them back from History or from the Recycle Bin.</p></div>
    ${whole.length ? `<div class="warnbox">In ${whole.length} duplicate group${whole.length === 1 ? '' : 's'} every file is selected, so none of that file stays: ${whole.slice(0, 3).map((g) => '“' + esc(g.label) + '”').join(', ')}${whole.length > 3 ? '…' : ''}</div>` : ''}
    <div class="dl">${shown.map((id) => { const f = S.files.get(id); return `<div><span class="n" title="${esc(f.path)}">${esc(f.path)}</span><span class="s">${size(f.size)}</span></div>`; }).join('')}
      ${ids.length > shown.length ? `<div><span class="n muted">and ${nf.format(ids.length - shown.length)} more</span></div>` : ''}</div>
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

function renderFolders(main) {
  const o = S.overview;
  main.innerHTML = header('Where to look', 'Sift only looks in these folders, and only when you press Scan.') + `<div class="page">
    <div class="card"><h2>Folders</h2><p class="hint">Untick a folder to leave it out without forgetting it.</p>
      <div class="list" id="folders">${o.folders.length ? o.folders.map((f, i) => `<div class="li ${f.enabled ? '' : 'off'}">
        <input type="checkbox" class="check" data-fi="${i}" ${f.enabled ? 'checked' : ''} title="Look in this folder">
        <span class="p" title="${esc(f.path)}">${esc(f.path)}</span>
        <button class="linkbtn quiet" data-show="${i}">Show</button><button class="linkbtn quiet" data-remove="${i}">Remove</button></div>`).join('') : '<div class="empty-list">No folders yet.</div>'}</div>
      <div class="addrow"><button class="btn primary" id="addFolder">Add a folder…</button></div></div>

    <div class="card"><h2>Skip</h2><p class="hint">Folders and patterns Sift never goes into. Use * for anything, like <b>*\\Steam\\*</b> or <b>*.tmp</b>.</p>
      <div class="list">${o.skip.length ? o.skip.map((p, i) => `<div class="li"><span class="p">${esc(p)}</span><button class="linkbtn quiet" data-unskip="${i}">Remove</button></div>`).join('') : '<div class="empty-list">Nothing skipped.</div>'}</div>
      <div class="addrow"><input id="skipIn" placeholder="A folder path or a pattern"><button class="btn" id="addSkip">Add</button></div></div>

    <div class="card"><h2>Kept files</h2><p class="hint">Files you chose to keep. Sift never suggests them for removal.</p>
      <div class="list">${o.kept.length ? o.kept.slice(0, 500).map((k, i) => `<div class="li"><span class="p" title="${esc(k.path)}">${esc(k.path)}</span><span class="m">${ago(k.at)}</span><button class="linkbtn quiet" data-unkeep="${i}">Stop keeping</button></div>`).join('') : '<div class="empty-list">None yet. Use Keep on a file in the lists.</div>'}</div></div>
  </div>`;
  const reload = async () => { await loadOverview(); render(); };
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
  main.querySelectorAll('[data-unkeep]').forEach((b) => (b.onclick = async () => {
    await invoke('unkeep', { paths: [o.kept[b.dataset.unkeep].path] }).catch(fail);
    await loadResult();
    reload();
  }));
  const addSkip = async () => {
    const v = $('#skipIn', main).value.trim();
    if (!v) return;
    await invoke('add_skip', { pattern: v }).catch(fail);
    reload();
  };
  $('#addSkip', main).onclick = addSkip;
  $('#skipIn', main).onkeydown = (e) => { if (e.key === 'Enter') addSkip(); };
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

// ---------- Settings ----------

const MIN_DUPE_STEPS = [0, 1024, 10240, 102400, 1 << 20, 10 << 20, 100 << 20];

const SETTINGS = [
  { section: 'Old downloads', items: [
    { key: 'untouchedMonths', title: 'Unused for at least', desc: 'A file nobody opened or changed for this long counts as old.', min: 1, max: 36, toUi: (v) => v, fromUi: (u) => u, label: (v) => `${v} month${v === 1 ? '' : 's'}` },
    { key: 'archiveMonths', title: 'Archives older than', desc: 'Zip, 7z and rar files older than this count as old, even if opened lately.', min: 1, max: 24, toUi: (v) => v, fromUi: (u) => u, label: (v) => `${v} month${v === 1 ? '' : 's'}` },
  ] },
  { section: 'Duplicates', items: [
    { key: 'minDupeSize', title: 'Leave out files smaller than', desc: 'Tiny files are rarely worth the time.', min: 0, max: MIN_DUPE_STEPS.length - 1, toUi: (v) => Math.max(0, MIN_DUPE_STEPS.indexOf(v)), fromUi: (u) => MIN_DUPE_STEPS[u], label: (v) => (v ? size(v) : 'Include all') },
    { key: 'similarNames', title: 'Similar names: how alike', desc: 'How close two names must be to show as “similar names”. Lower finds more, and more that are not really the same.', min: 79, max: 99, toUi: (v) => (v ? v : 79), fromUi: (u) => (u === 79 ? 0 : u), label: (v) => (v ? v + '%' : 'Off') },
  ] },
];

function renderSettings(main) {
  main.innerHTML = header('Settings', 'Changes apply from the next scan.') + `<div class="page">` + SETTINGS.map((sec) => `<div class="card"><h2>${sec.section}</h2>
    ${sec.items.map((it) => { const v = setting(it.key); return `<div class="setting"><div class="t">${it.title}</div><div class="d">${it.desc}</div>
      <div class="ctl"><input type="range" data-key="${it.key}" min="${it.min}" max="${it.max}" value="${it.toUi(v)}"><output>${esc(it.label(v))}</output></div></div>`; }).join('')}</div>`).join('') +
    `<div class="card"><h2>Back to the start</h2><p class="hint">Puts every slider back where Sift started.</p><button class="btn" id="reset">Reset sliders</button></div></div>`;
  const all = SETTINGS.flatMap((s) => s.items);
  main.querySelectorAll('input[data-key]').forEach((inp) => {
    const it = all.find((x) => x.key === inp.dataset.key);
    inp.oninput = () => { inp.nextElementSibling.textContent = it.label(it.fromUi(Number(inp.value))); };
    inp.onchange = async () => {
      const v = it.fromUi(Number(inp.value));
      await invoke('set_setting', { key: it.key, value: String(v) }).catch(fail);
      S.overview.settings[it.key] = String(v);
    };
  });
  $('#reset', main).onclick = async () => {
    for (const [k, v] of Object.entries(DEFAULTS)) await invoke('set_setting', { key: k, value: String(v) }).catch(fail);
    await loadOverview();
    render();
  };
}

// ---------- Start ----------

async function start() {
  document.querySelectorAll('.navitem').forEach((b) => (b.onclick = () => go(b.dataset.view)));
  $('#scanBtn').onclick = scanOrStop;
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
  if (!S.result) S.view = 'folders';
  render();
}

start();
