// Stands in for the Rust side so the window can be tried in a browser. Made-up files only.
(function () {
  const now = Math.floor(Date.now() / 1000), M = 30 * 86400;
  const D = 'C:\\Users\\Kuno\\Downloads';
  const files = [];
  const add = (name, dir, size, ageM, kind, origin, ext) => {
    const id = files.length;
    files.push({ id, path: dir + '\\' + name, dir, name, ext: ext || name.split('.').pop().toLowerCase(), kind, size, modified: now - ageM * M, created: now - (ageM + 1) * M, touched: now - ageM * M, origin, kept: false });
    return id;
  };
  const old = [], groups = [];
  const a = add('vlc-3.0.18-win64.exe', D, 42e6, 14, 'installer', 'videolan.org');
  const b = add('vlc-3.0.20-win64.exe', D, 43e6, 3, 'installer', 'videolan.org');
  const c = add('ChromeSetup.exe', D, 1.3e6, 20, 'installer', 'google.com');
  const d = add('holiday-photos.zip', D, 840e6, 5, 'archive', 'drive.google.com');
  const e = add('Firefox Setup 120.0.exe', D, 56e6, 11, 'installer', 'mozilla.org');
  const f = add('setup (1).exe', D, 5e6, 2, 'installer', 'github.com');
  const g = add('setup.exe', D, 5e6, 2, 'installer', 'github.com');
  const h = add('Belastingaangifte 2022.pdf', D, 2.1e6, 30, 'document');
  const i = add('Belastingaangifte 2022 - Kopie.pdf', 'C:\\Users\\Kuno\\Documents', 2.1e6, 30, 'document');
  const j = add('ubuntu-24.04-desktop-amd64.iso', D, 6.1e9, 9, 'disk', 'ubuntu.com');
  files[j].originDetail = 'Page: https://ubuntu.com/download/desktop\nFile: https://releases.ubuntu.com/24.04/ubuntu-24.04-desktop-amd64.iso';
  old.push({ file: a, signals: [{ type: 'untouched', months: 14 }, { type: 'superseded', newer: 'vlc-3.0.20-win64.exe' }, { type: 'installed', program: 'VLC media player' }] });
  old.push({ file: b, signals: [{ type: 'installed', program: 'VLC media player' }] });
  old.push({ file: c, signals: [{ type: 'untouched', months: 20 }, { type: 'installed', program: 'Google Chrome' }] });
  old.push({ file: d, signals: [{ type: 'unpacked', folder: D + '\\holiday-photos' }, { type: 'oldArchive', months: 5 }] });
  old.push({ file: e, signals: [{ type: 'untouched', months: 11 }, { type: 'installed', program: 'Mozilla Firefox (x64 en-US)' }] });
  old.push({ file: h, signals: [{ type: 'untouched', months: 30 }] });
  old.push({ file: j, signals: [{ type: 'untouched', months: 9 }] });
  for (let n = 0; n < 4000; n++) {
    const ext = ['pdf', 'zip', 'exe', 'jpg', 'docx', 'mp4'][n % 6];
    const kind = { pdf: 'document', zip: 'archive', exe: 'installer', jpg: 'image', docx: 'document', mp4: 'video' }[ext];
    const id = add(`file-${n}.${ext}`, D + (n % 3 ? '\\Old stuff' : ''), Math.round(Math.random() * 3e8), 6 + (n % 40), kind, n % 4 ? 'example.com' : undefined);
    old.push({ file: id, signals: [{ type: 'untouched', months: 6 + (n % 40) }] });
  }
  groups.push({ kind: 'copies', files: [g, f], suggested: g, label: 'setup.exe', fingerprint: '9e107d9d372bb6826bd81d3542a419d6' });
  groups.push({ kind: 'copies', files: [h, i], suggested: h, label: 'Belastingaangifte 2022.pdf', fingerprint: 'e4d909c290d0fb1ca068ffaddf22cbd0' });
  const w1 = add('WindowsClient.zip', D, 6.4e6, 60, 'archive', 'github.com');
  const w2 = add('0.9.5 ValheimPlus Windows Client-4-0-9-5-1-1615635599.zip', D, 6.4e6, 60, 'archive', 'nexusmods.com');
  groups.push({ kind: 'sameContent', files: [w2, w1], suggested: w2, label: w2 === 0 ? '' : '0.9.5 ValheimPlus Windows Client-4-0-9-5-1-1615635599.zip', fingerprint: 'd41d8cd98f00b204e9800998ecf8427e' });
  groups.push({ kind: 'versions', files: [a, b], suggested: b, label: 'vlc' });
  const m1 = add('report.docx', D, 120e3, 4, 'document');
  const m2 = add('report (1).docx', D, 131e3, 3, 'document');
  const m3 = add('report (2).docx', D, 133e3, 2, 'document');
  groups.push({ kind: 'sameName', files: [m1, m2, m3], suggested: m3, label: 'report.docx' });
  const s1 = add('invoice-march.pdf', D, 80e3, 4, 'document');
  const s2 = add('invoice-march.pdf', 'C:\\Users\\Kuno\\Desktop', 81e3, 3, 'document');
  const q1 = add('report.pdf', D, 310e3, 6, 'document');
  const q2 = add('report (1).pdf', D, 310e3, 5, 'document');
  groups.push({ kind: 'copies', files: [q1, q2], suggested: q1, label: 'report.pdf', fingerprint: '5d41402abc4b2a76b9719d911017c592' });
  groups.push({ kind: 'sameName', files: [s1, s2], suggested: s2, label: 'invoice-march.pdf' });
  for (let n = 0; n < 300; n++) {
    const x = add(`movie-${n}.mkv`, 'D:\\Films', 1.4e9, 12, 'video');
    const y = add(`movie-${n}.mkv`, 'E:\\Backup\\Films', 1.4e9, 30, 'video');
    groups.push({ kind: 'copies', files: [x, y], suggested: y, label: `movie-${n}.mkv` });
  }
  // ---- Jobs, presets and results ----
  const gkey = (g) => g.kind + ':' + g.files.map((id) => files[id].path.toLowerCase()).sort().join('|');
  for (const g of groups) { g.key = gkey(g); g.folderPick = null; }
  const used = (gs, os) => { const ids = new Set(os.map((o) => o.file)); for (const g of gs) for (const id of g.files) ids.add(id); return files.filter((f) => ids.has(f.id)); };
  const fullResult = () => ({ startedAt: now - 7300, finishedAt: now - 7200, folders: [D], files: used(groups, old), old, groups, stats: { filesSeen: 48211, bytesSeen: 312e9, foldersSeen: 3100, unreadable: 0, hashedBytes: 9e9 }, cancelled: false });
  const filmGroups = groups.filter((g) => g.label.startsWith('movie-'));
  const filmsResult = () => ({ startedAt: now - 100, finishedAt: now - 60, folders: ['D:\\Films'], files: used(filmGroups, []), old: [], groups: filmGroups, stats: { filesSeen: 1800, bytesSeen: 900e9, foldersSeen: 40, unreadable: 0, hashedBytes: 3e9 }, cancelled: false });

  const BUILTIN = [
    ['quick', 'Quick scan', 'Old files and obvious copies, big files only. Fast: names and sizes first.', true, true, { untouchedMonths: 12, archiveMonths: 6, minSize: 1 << 20, kinds: { sameName: false, similarName: false } }],
    ['thorough', 'Thorough clean', 'Everything Sift can tell, small files too, and names that are only alike.', true, true, { minSize: 0, similar: 90 }],
    ['obvious', 'Obvious duplicates', 'Only the same file twice, and older versions of one installer.', false, true, { kinds: { sameContent: false, sameName: false, similarName: false } }],
    ['deeper', 'Deeper duplicates', 'Also the same content under other names, the same name with other content, and similar names.', false, true, { minSize: 0, similar: 88 }],
    ['installers', 'Installer leftovers', 'Installers that are installed already, replaced by a newer version, or just old.', true, false, { untouchedMonths: 3, extensions: ['exe', 'msi', 'msix', 'msixbundle', 'appx', 'appxbundle'] }],
    ['archives', 'Old archives', 'Zip, 7z, rar and the like that are old or already unpacked.', true, false, { untouchedMonths: 12, archiveMonths: 6, extensions: ['zip', '7z', 'rar', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'zst', 'cab'] }],
  ].map(([id, name, description, findOld, findDupes, o]) => ({ id, name, description, findOld, findDupes, settings: baseSettings(o) }));
  function baseSettings(o = {}) {
    return { untouchedMonths: 6, archiveMonths: 3, minSize: 1024, maxSize: 0, similar: 95, dateBy: 'modified', dateFrom: null, dateTo: null, extensions: [], skipSystem: false, ...o, kinds: { copies: true, versions: true, sameContent: true, sameName: true, similarName: true, ...(o.kinds || {}) } };
  }
  const userPresets = [];
  const pool = [D, 'D:\\Films', 'E:\\Backup'];
  const jobs = [
    { id: 1, name: 'Downloads', folders: [{ path: D, active: true, recursive: true }, { path: 'D:\\Films', active: false, recursive: true }, { path: 'E:\\Backup', active: false, recursive: true }], findOld: true, findDupes: true, preset: null, settings: baseSettings(), step: 'results', list: 'old' },
    { id: 2, name: 'Films', folders: [{ path: D, active: false, recursive: true }, { path: 'D:\\Films', active: true, recursive: true }, { path: 'E:\\Backup', active: true, recursive: false }], findOld: false, findDupes: true, preset: 'obvious', settings: baseSettings({ kinds: { sameContent: false, sameName: false, similarName: false } }), step: 'setup', list: 'dupes' },
  ];
  const results = { 1: location.hash === '#empty' ? null : fullResult(), 2: null };
  const states = { 1: { selOld: [], selDupes: [], reviewed: [], ignored: [] }, 2: { selOld: [], selDupes: [], reviewed: [], ignored: [] } };
  let nextJob = 3, droppedOnce = location.hash === '#dropped' ? 3 : 0;
  const ov = {
    skip: ['*\\$RECYCLE.BIN', '*\\.git', '*\\node_modules', '*\\System Volume Information'],
    kept: [], settings: { activeJob: '1' }, removals: [], canPutBack: true,
    scans: [{ id: 1, startedAt: now - 7300, finishedAt: now - 7200, folders: D, filesSeen: 48211, bytesSeen: 312e9, oldCount: old.length, groupCount: groups.length, cancelled: false }],
  };
  const norm = (p) => p.replace(/\\/g, '/').toLowerCase();
  const rankOf = (path, order) => { let best = -1, len = -1; order.forEach((f, i) => { const n = norm(f).replace(/\/$/, ''); if (norm(path).startsWith(n + '/') && n.length > len) { len = n.length; best = i; } }); return best < 0 ? null : best; };
  const picks = (r, job) => {
    const order = job.folders.filter((f) => f.active).map((f) => f.path);
    return r.groups.map((g) => {
      if (g.kind !== 'copies' && g.kind !== 'sameContent') return null;
      let best = null, tied = false;
      for (const id of g.files) { const rk = rankOf(files[id].path, order); if (rk === null) continue; if (best === null || rk < best.rk) { best = { rk, id }; tied = false; } else if (rk === best.rk) tied = true; }
      return tied || !best ? null : best.id;
    });
  };
  const withPicks = (r, job) => { if (r) picks(r, job).forEach((p, i) => { r.groups[i].folderPick = p; }); return r; };
  const mainGroups = (r) => r.groups.filter((g) => g.kind === 'copies' || g.kind === 'versions').length;
  const counts = () => { const c = {}; for (const j of jobs) { const r = results[j.id]; if (r) c[j.id] = { old: r.old.length, groups: mainGroups(r), finishedAt: r.finishedAt, reviewed: states[j.id].reviewed.length }; } return c; };
  const jobOf = (id) => jobs.find((j) => j.id === id);
  const running = new Map();
  let histId = 0;
  const disk = new Set(files.map((f) => f.path.toLowerCase()));
  // A small copy of what core/src/plan.rs does, so the Act step can be tried in a browser.
  const baseOf = (p) => p.split('\\').pop();
  const dirOf = (p) => p.slice(0, p.lastIndexOf('\\'));
  const cleanOf = (name) => { const m = name.match(/^(.+?)(?:\s*\(\d{1,3}\)|\s*-\s*(?:copy|kopie)(?:\s*\(\d+\))?|\s\d{1,2})(\.[A-Za-z0-9]+)?$/i); return m ? m[1] + (m[2] || '') : null; };
  const numberedName = (name, n) => name.replace(/(\.[^.]*)?$/, ` (${n})$1`);
  const joinPath = (a, b) => a.replace(/\\+$/, '') + (b ? '\\' + b : '\\');
  const buildPlan = (r, req, job) => {
    const order = job.folders.filter((f) => f.active).map((f) => f.path);
    const byId = new Map(r.files.map((f) => [f.id, f]));
    const locked = new Set([...req.locked, ...r.files.filter((f) => f.kept).map((f) => f.id)]);
    const selD = new Set(req.selectedDupes), selO = new Set(req.selectedOld);
    const goes = [], goSet = new Set(), stays = [], acted = [];
    let undecided = 0;
    for (const sg of req.shownGroups) {
      const g = r.groups.find((x) => x.key === sg.key);
      if (!g) continue;
      const level = g.kind === 'copies' || g.kind === 'versions' ? 'sure' : 'notSure';
      const strat = level === 'sure' ? req.sure : req.notSure;
      if (strat === 'leave') continue;
      const ids = sg.files.filter((id) => g.files.includes(id) && byId.has(id));
      let remove, keepers;
      if (strat === 'selected') {
        remove = ids.filter((id) => selD.has(id) && !locked.has(id));
        keepers = ids.filter((id) => !remove.includes(id) && !locked.has(id));
      } else {
        if (ids.length < 2) continue;
        let keep = null;
        const fs = ids.map((id) => byId.get(id));
        if (!ids.some((id) => locked.has(id))) {
          if (strat === 'folderOrder') {
            let best = null, tied = false;
            if (g.kind === 'copies' || g.kind === 'sameContent') for (const f of fs) { const rk = rankOf(f.path, order); if (rk === null) continue; if (best === null || rk < best.rk) { best = { rk, id: f.id }; tied = false; } else if (rk === best.rk) tied = true; }
            if (!best || tied) { undecided++; continue; }
            keep = best.id;
          } else {
            const key = (f) => (strat === 'newest' ? f.modified : strat === 'oldest' ? -f.modified : f.size);
            keep = fs.slice().sort((a, b) => key(b) - key(a) || a.id - b.id)[0].id;
          }
        }
        remove = ids.filter((id) => id !== keep && !locked.has(id));
        keepers = keep === null ? [] : [keep];
      }
      if (!remove.length) continue;
      acted.push(g);
      for (const id of remove) if (!goSet.has(id)) { goSet.add(id); goes.push([id, level, g]); }
      for (const id of keepers) stays.push([id, level, g]);
    }
    if (req.old === 'selected') for (const id of req.shownOld) if (selO.has(id) && !locked.has(id) && byId.has(id) && !goSet.has(id)) { goSet.add(id); goes.push([id, 'old', null]); }
    const seen = new Set();
    const stay2 = stays.filter(([id]) => !goSet.has(id) && !seen.has(id) && seen.add(id));
    const wiped = r.groups.filter((g) => g.files.length >= 2 && g.files.every((id) => goSet.has(id))).map((g) => g.label);
    const taken = new Set(), vacated = new Set();
    const busy = (p) => taken.has(p.toLowerCase()) || (disk.has(p.toLowerCase()) && !vacated.has(p.toLowerCase()));
    const free = (dir, name) => { let p = joinPath(dir, name), n = 1; while (busy(p)) { n++; p = joinPath(dir, numberedName(name, n)); } taken.add(p.toLowerCase()); return p; };
    const plan = { items: [], ops: [], skipped: [], undecided, wiped, totals: { go: 0, goBytes: 0, stay: 0, keptMoved: 0, renamed: 0 } };
    for (const [id, level, g] of goes) {
      const f = byId.get(id);
      let fate = 'recycle', kind = 'recycle', to = null;
      if (req.removal.type === 'delete') { fate = 'delete'; kind = 'delete'; }
      if (req.removal.type === 'move') {
        const roots = order.filter((o) => norm(f.dir) === norm(o) || norm(f.dir).startsWith(norm(o).replace(/\/$/, '') + '/')).sort((a, b) => b.length - a.length);
        const rel = req.removal.keepStructure && roots.length ? f.dir.slice(roots[0].length).replace(/^\\+/, '') : '';
        to = free(joinPath(req.removal.to, rel).replace(/\\$/, ''), f.name); fate = 'move'; kind = 'move';
      }
      vacated.add(f.path.toLowerCase());
      plan.ops.push({ id, kind, from: f.path, to, reason: g ? 'Duplicate: ' + g.label : 'Old download' });
      plan.items.push({ id, path: f.path, level, group: g ? g.label : null, fate, movedTo: to, renamedTo: null });
      plan.totals.go++; plan.totals.goBytes += f.size;
    }
    const renames = [];
    for (const [id, level, g] of stay2) {
      const f = byId.get(id);
      const item = { id, path: f.path, level, group: g.label, fate: 'stays', movedTo: null, renamedTo: null };
      let here = f.path;
      if (req.moveKept) { const to = free(req.moveKept, f.name); vacated.add(f.path.toLowerCase()); plan.ops.push({ id, kind: 'move', from: f.path, to, reason: 'Kept file of ' + g.label }); plan.totals.keptMoved++; item.movedTo = to; here = to; }
      if (req.renameKept) {
        const clean = cleanOf(baseOf(here));
        if (clean) {
          const target = joinPath(dirOf(here), clean).replace(/\\$/, '');
          if (busy(target)) plan.skipped.push({ id, path: f.path, reason: `“${clean}” is already in that folder` });
          else { taken.add(target.toLowerCase()); vacated.add(here.toLowerCase()); renames.push({ id, kind: 'rename', from: here, to: target, reason: 'Renamed to its clean name' }); plan.totals.renamed++; item.renamedTo = target; }
        }
      }
      plan.totals.stay++;
      plan.items.push(item);
    }
    plan.ops.push(...renames);
    return plan;
  };
  const handlers = {
    overview: () => JSON.parse(JSON.stringify({ ...ov, jobs, counts: counts(), presets: BUILTIN, userPresets })),
    job_create: () => { const q = BUILTIN[0]; let n = 1; while (jobs.some((j) => j.name.toLowerCase() === 'job ' + n)) n++; const j = { id: nextJob++, name: 'Job ' + n, folders: pool.map((path) => ({ path, active: false, recursive: true })), findOld: q.findOld, findDupes: q.findDupes, preset: q.id, settings: JSON.parse(JSON.stringify(q.settings)), step: 'setup', list: 'old' }; jobs.push(j); states[j.id] = { selOld: [], selDupes: [], reviewed: [], ignored: [] }; results[j.id] = null; return JSON.parse(JSON.stringify(j)); },
    job_duplicate: ({ id }) => { const j = JSON.parse(JSON.stringify(jobOf(id))); j.id = nextJob++; j.name += ' copy'; j.step = 'setup'; jobs.push(j); states[j.id] = { selOld: [], selDupes: [], reviewed: [], ignored: [] }; results[j.id] = null; return j; },
    job_save: ({ job }) => { if (!job.findOld && !job.findDupes) throw 'A job has to look for at least one thing.'; Object.assign(jobOf(job.id), JSON.parse(JSON.stringify(job))); },
    job_delete: ({ id }) => { jobs.splice(jobs.findIndex((j) => j.id === id), 1); delete results[id]; },
    job_open: ({ id }) => { const r = results[id]; const d = id === 1 && r ? droppedOnce : 0; droppedOnce = 0; return JSON.stringify({ result: withPicks(r && JSON.parse(JSON.stringify(r)), jobOf(id)), state: states[id], dropped: d }); },
    job_state_save: ({ id, state }) => { states[id] = state; },
    job_picks: ({ id }) => (results[id] ? picks(results[id], jobOf(id)) : []),
    preset_save: ({ name, values }) => { const id = 'u' + (userPresets.length + 1); userPresets.push({ id, name, ...JSON.parse(JSON.stringify(values)) }); return id; },
    preset_rename: ({ id, name }) => { userPresets.find((p) => p.id === id).name = name; },
    preset_delete: ({ id }) => { userPresets.splice(userPresets.findIndex((p) => p.id === id), 1); jobs.forEach((j) => { if (j.preset === id) j.preset = null; }); },
    keep: ({ paths }) => { for (const p of paths) { ov.kept.unshift({ path: p, at: now }); const fl = files.find((x) => x.path === p); if (fl) fl.kept = true; } for (const r of Object.values(results)) if (r) r.old = r.old.filter((o) => !files[o.file].kept); },
    unkeep: ({ paths }) => { ov.kept = ov.kept.filter((k) => !paths.includes(k.path)); for (const fl of files) if (paths.includes(fl.path)) fl.kept = false; },
    set_setting: ({ key, value }) => { ov.settings[key] = value; },
    plan_act: ({ jobId, req }) => buildPlan(results[jobId], req, jobOf(jobId)),
    act: ({ jobId, req, confirmedDelete }) => {
      if (req.removal.type === 'delete' && !confirmedDelete) throw 'Deleting for good has to be confirmed first.';
      const plan = buildPlan(results[jobId], req, jobOf(jobId));
      const out = { recycled: 0, moved: 0, renamed: 0, deleted: 0, failed: [] };
      const word = { recycle: 'recycled', move: 'moved', rename: 'renamed', delete: 'deleted' };
      const changed = new Set();
      for (const op of plan.ops) {
        const f = files[op.id];
        if (op.kind === 'move') { let to = op.to, n = 1; while (disk.has(to.toLowerCase())) { n++; to = joinPath(dirOf(op.to), numberedName(baseOf(op.from), n)); } op.to = to; disk.add(to.toLowerCase()); }
        if (op.kind === 'rename') disk.add(op.to.toLowerCase());
        disk.delete(op.from.toLowerCase());
        ov.removals.unshift({ id: ++histId, at: now, kind: word[op.kind], path: op.from, to: op.to || null, size: f.size, reason: op.reason, restoredAt: null });
        out[word[op.kind]]++;
        changed.add(op.id);
      }
      for (const [k, r] of Object.entries(results)) {
        if (!r) continue;
        const groups2 = r.groups.map((g) => ({ ...g, files: g.files.filter((i) => !changed.has(i)) })).filter((g) => g.files.length > 1);
        groups2.forEach((g) => { g.key = gkey(g); });
        results[k] = { ...r, files: r.files.filter((f) => !changed.has(f.id)), old: r.old.filter((o) => !changed.has(o.file)), groups: groups2 };
      }
      return out;
    },
    undo: ({ id }) => {
      const x = ov.removals.find((r) => r.id === id);
      if (x.kind === 'deleted') throw "A permanent delete can't be undone.";
      x.restoredAt = now;
    },
    scan: ({ jobId }) => new Promise((res, rej) => {
      if (running.has(jobId)) return rej('This job is already scanning.');
      if (running.size >= 3) return rej('Three scans are running; wait or stop one.');
      const job = jobOf(jobId);
      if (!job.folders.some((f) => f.active)) return rej('Tick at least one folder to look in first.');
      running.set(jobId, { stop: false });
      let n = 0;
      const t = setInterval(() => {
        n += 5000;
        listeners['scan-progress']?.({ payload: n < 30000 ? { jobId, phase: 'looking', files: n } : { jobId, phase: 'comparing', done: n - 30000, total: 20000 } });
        const stop = running.get(jobId).stop;
        if (stop || n >= 50000) {
          clearInterval(t);
          running.delete(jobId);
          if (stop) return res(JSON.stringify({ result: null, state: states[jobId], dropped: 0 }));
          results[jobId] = jobId === 1 ? fullResult() : filmsResult();
          if (job.findOld === false) results[jobId].old = [];
          res(JSON.stringify({ result: withPicks(JSON.parse(JSON.stringify(results[jobId])), job), state: states[jobId], dropped: 0 }));
        }
      }, 150);
    }),
    cancel_scan: ({ jobId }) => { if (running.has(jobId)) running.get(jobId).stop = true; },
    pick_folder: () => 'C:\\Users\\Kuno\\Desktop',
    add_folders: ({ jobId, paths }) => { for (const path of paths) { if (!pool.some((p) => p.toLowerCase() === path.toLowerCase())) pool.push(path); for (const j of jobs) { const f = j.folders.find((x) => x.path.toLowerCase() === path.toLowerCase()); if (f) { if (j.id === jobId) f.active = true; } else j.folders.push({ path, active: j.id === jobId, recursive: true }); } } },
    remove_folder: ({ path }) => { pool.splice(pool.indexOf(path), 1); jobs.forEach((j) => { j.folders = j.folders.filter((f) => f.path !== path); }); },
    add_skip: ({ pattern }) => ov.skip.push(pattern), remove_skip: ({ pattern }) => { ov.skip = ov.skip.filter((p) => p !== pattern); },
    show_in_folder: () => {}, open_file: () => {},
  };
  const listeners = {};
  window.__TAURI__ = {
    core: { invoke: async (cmd, args) => { if (!handlers[cmd]) throw new Error('mock: ' + cmd); return handlers[cmd](args || {}); } },
    event: { listen: async (name, cb) => { listeners[name] = cb; return () => {}; } },
  };
})();
