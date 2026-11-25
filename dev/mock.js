// Stands in for the Rust side so the window can be tried in a browser. Made-up files only.
(function () {
  const now = Math.floor(Date.now() / 1000), M = 30 * 86400;
  const D = 'C:\\Users\\Kuno\\Downloads';
  const files = [];
  const add = (name, dir, size, ageM, kind, origin, ext) => {
    const id = files.length;
    files.push({ id, path: dir + '\\' + name, dir, name, ext: ext || name.split('.').pop().toLowerCase(), kind, size, modified: now - ageM * M, touched: now - ageM * M, origin, kept: false });
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
  groups.push({ kind: 'sameContent', files: [g, f], suggested: g, label: 'setup.exe' });
  groups.push({ kind: 'sameContent', files: [h, i], suggested: h, label: 'Belastingaangifte 2022.pdf' });
  groups.push({ kind: 'versions', files: [a, b], suggested: b, label: 'vlc' });
  const m1 = add('report.docx', D, 120e3, 4, 'document');
  const m2 = add('report (1).docx', D, 131e3, 3, 'document');
  const m3 = add('report (2).docx', D, 133e3, 2, 'document');
  groups.push({ kind: 'copies', files: [m1, m2, m3], suggested: m1, label: 'report.docx' });
  const s1 = add('invoice-march.pdf', D, 80e3, 4, 'document');
  const s2 = add('invoice-march.pdf', 'C:\\Users\\Kuno\\Desktop', 81e3, 3, 'document');
  groups.push({ kind: 'sameName', files: [s1, s2], suggested: s2, label: 'invoice-march.pdf' });
  for (let n = 0; n < 300; n++) {
    const x = add(`movie-${n}.mkv`, 'D:\\Films', 1.4e9, 12, 'video');
    const y = add(`movie-${n}.mkv`, 'E:\\Backup\\Films', 1.4e9, 30, 'video');
    groups.push({ kind: 'sameContent', files: [x, y], suggested: y, label: `movie-${n}.mkv` });
  }
  let result = { startedAt: now - 7300, finishedAt: now - 7200, folders: [D], files, old, groups, stats: { filesSeen: 48211, bytesSeen: 312e9, foldersSeen: 3100, unreadable: 0, hashedBytes: 9e9 }, cancelled: false };
  const ov = {
    folders: [{ path: D, enabled: true }, { path: 'D:\\Films', enabled: true }, { path: 'E:\\Backup', enabled: false }],
    skip: ['*\\$RECYCLE.BIN', '*\\.git', '*\\node_modules', '*\\System Volume Information'],
    kept: [], settings: {}, removals: [], scans: [{ id: 1, startedAt: now - 7300, finishedAt: now - 7200, folders: D, filesSeen: 48211, bytesSeen: 312e9, oldCount: old.length, groupCount: groups.length, cancelled: false }], canPutBack: true,
  };
  const empty = location.hash === '#empty';
  const handlers = {
    overview: () => JSON.parse(JSON.stringify(ov)),
    last_result: () => (empty ? null : JSON.stringify(result)),
    keep: ({ paths }) => { for (const p of paths) { ov.kept.unshift({ path: p, at: now }); const fl = files.find((x) => x.path === p); if (fl) fl.kept = true; } result.old = result.old.filter((o) => !files[o.file].kept); },
    unkeep: ({ paths }) => { ov.kept = ov.kept.filter((k) => !paths.includes(k.path)); for (const fl of files) if (paths.includes(fl.path)) fl.kept = false; },
    set_setting: ({ key, value }) => { ov.settings[key] = value; },
    recycle: ({ items }) => {
      const gone = new Set(items.map((x) => x.path));
      items.forEach((x, k) => ov.removals.unshift({ id: ov.removals.length + 1, at: now, path: x.path, size: files.find((f) => f.path === x.path).size, reason: x.reason, restoredAt: null }));
      const ids = new Set(files.filter((f) => gone.has(f.path)).map((f) => f.id));
      result = { ...result, files: result.files.filter((f) => !ids.has(f.id)), old: result.old.filter((o) => !ids.has(o.file)), groups: result.groups.map((g) => ({ ...g, files: g.files.filter((i) => !ids.has(i)) })).filter((g) => g.files.length > 1) };
      return { moved: [...gone], failed: [] };
    },
    put_back: ({ id }) => { const r = ov.removals.find((x) => x.id === id); r.restoredAt = now; },
    scan: () => new Promise((res) => { let n = 0; const t = setInterval(() => { n += 5000; listeners['scan-progress']?.({ payload: n < 30000 ? { phase: 'looking', files: n } : { phase: 'comparing', done: n - 30000, total: 20000 } }); if (n >= 50000) { clearInterval(t); res(JSON.stringify(result)); } }, 150); }),
    cancel_scan: () => {}, pick_folder: () => 'C:\\Users\\Kuno\\Desktop', add_folder: ({ path }) => ov.folders.push({ path, enabled: true }),
    set_folder_enabled: ({ path, enabled }) => { ov.folders.find((f) => f.path === path).enabled = enabled; },
    remove_folder: ({ path }) => { ov.folders = ov.folders.filter((f) => f.path !== path); },
    add_skip: ({ pattern }) => ov.skip.push(pattern), remove_skip: ({ pattern }) => { ov.skip = ov.skip.filter((p) => p !== pattern); },
    show_in_folder: () => {}, open_file: () => {},
  };
  const listeners = {};
  window.__TAURI__ = {
    core: { invoke: async (cmd, args) => { if (!handlers[cmd]) throw new Error('mock: ' + cmd); return handlers[cmd](args || {}); } },
    event: { listen: async (name, cb) => { listeners[name] = cb; return () => {}; } },
  };
})();
